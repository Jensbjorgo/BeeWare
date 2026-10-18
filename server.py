
from __future__ import annotations

import csv
import hashlib
import heapq
import json
import math
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
WEB_DIR = BASE_DIR / "web"
STORAGE_DIR = BASE_DIR / "storage"
DB_FILE = STORAGE_DIR / "beeware.db"

SIGHTING_TTL_HOURS = 3
MAX_SIGHTINGS = 500
STOP_SEARCH_LIMIT = 12
ROUTE_SEARCH_LIMIT = 12
NEARBY_STOP_LIMIT = 6
NEARBY_RADIUS_KM = 2.0
EARTH_RADIUS_KM = 6371.0
SESSION_COOKIE = "beeware_session"
SESSION_TTL_SECONDS = 14 * 24 * 60 * 60
PBKDF2_ITERATIONS = 120_000
XP_PER_LIKE = 10
MAX_BODY_BYTES = 4096
REQUEST_TIMEOUT_SECONDS = 10
MAX_CONNECTIONS = 64
STOP_NAME_MAX = 80
ROUTE_MAX = 40
NOTE_MAX = 160
STOP_ID_MAX = 64
# (requests, seconds) per client IP. Three reports per ten minutes means one
# client cannot push all active reports out of the 500-report store.
RATE_LIMITS = {"sighting": (3, 600), "login": (10, 300), "register": (3, 3600)}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat1_rad = math.radians(lat1)
    lon1_rad = math.radians(lon1)
    lat2_rad = math.radians(lat2)
    lon2_rad = math.radians(lon2)
    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def compact_whitespace(value: str) -> str:
    return " ".join(value.split())


def clean_text(value: Any, limit: int) -> str:
    text = compact_whitespace(str(value or ""))[:limit]
    text.encode("utf-8")  # Raises UnicodeEncodeError (a ValueError) for lone surrogates.
    return text


def parse_coordinate(value: Any, limit: float) -> float:
    if isinstance(value, bool):
        raise ValueError("not a number")
    try:
        number = float(value)
    except OverflowError as exc:  # A huge JSON integer is not a ValueError.
        raise ValueError("out of range") from exc
    if not math.isfinite(number) or abs(number) > limit:
        raise ValueError("out of range")
    return number


class TransitData:
    def __init__(self, data_dir: Path) -> None:
        self.stops_by_id: dict[str, dict[str, Any]] = {}
        self.route_index: list[dict[str, str]] = []
        if (data_dir / "stops.txt").is_file():
            self._load_stops(data_dir / "stops.txt")
        if (data_dir / "routes.txt").is_file():
            self._load_routes(data_dir / "routes.txt")

    def _load_stops(self, path: Path) -> None:
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                try:
                    lat = float(row["stop_lat"])
                    lon = float(row["stop_lon"])
                except (TypeError, ValueError):
                    continue

                stop = {
                    "id": row["stop_id"],
                    "name": compact_whitespace(row["stop_name"]),
                    "lat": lat,
                    "lon": lon,
                    "platform": row.get("platform_code") or "",
                    "description": compact_whitespace(row.get("stop_desc") or ""),
                }
                self.stops_by_id[stop["id"]] = stop

    def _load_routes(self, path: Path) -> None:
        seen: set[tuple[str, str]] = set()
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                short_name = compact_whitespace(row.get("route_short_name") or "")
                long_name = compact_whitespace(row.get("route_long_name") or "")
                key = (short_name.casefold(), long_name.casefold())
                if not short_name or key in seen:
                    continue
                seen.add(key)
                self.route_index.append(
                    {
                        "id": row["route_id"],
                        "short_name": short_name,
                        "long_name": long_name,
                        "label": f"{short_name} {long_name}".strip(),
                    }
                )
        self.route_index.sort(key=lambda item: item["short_name"])

    def search_stops(self, query: str, limit: int = STOP_SEARCH_LIMIT) -> list[dict[str, Any]]:
        needle = compact_whitespace(query).casefold()
        if len(needle) < 2:
            return []

        results: list[dict[str, Any]] = []
        seen_names: set[str] = set()
        for stop in self.stops_by_id.values():
            haystack = f"{stop['name']} {stop['description']} {stop['platform']}".casefold()
            if needle not in haystack:
                continue
            dedupe_key = f"{stop['name'].casefold()}|{round(stop['lat'], 5)}|{round(stop['lon'], 5)}"
            if dedupe_key in seen_names:
                continue
            seen_names.add(dedupe_key)
            results.append(stop)
            if len(results) >= limit:
                break
        return results

    def search_routes(self, query: str, limit: int = ROUTE_SEARCH_LIMIT) -> list[dict[str, str]]:
        needle = compact_whitespace(query).casefold()
        if not needle:
            return self.route_index[:limit]

        results = []
        for route in self.route_index:
            haystack = f"{route['short_name']} {route['long_name']}".casefold()
            if needle in haystack:
                results.append(route)
            if len(results) >= limit:
                break
        return results

    def find_nearby_stops(
        self, lat: float, lon: float, limit: int = NEARBY_STOP_LIMIT
    ) -> list[dict[str, Any]]:
        # ponytail: scans every stop; add a spatial index if a national feed makes this slow.
        distances = ((haversine_km(lat, lon, stop["lat"], stop["lon"]), stop) for stop in self.stops_by_id.values())
        nearest = heapq.nsmallest(limit, distances, key=lambda item: item[0])
        return [
            {**stop, "distance_m": int(distance_km * 1000)}
            for distance_km, stop in nearest
            if distance_km <= NEARBY_RADIUS_KM
        ]


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    key TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at REAL NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    likes_received INTEGER NOT NULL DEFAULT 0,
    sightings_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_key TEXT NOT NULL REFERENCES users(key) ON DELETE CASCADE,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sightings (
    id TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    route TEXT NOT NULL,
    note TEXT NOT NULL,
    reporter TEXT NOT NULL,
    owner TEXT REFERENCES users(key) ON DELETE SET NULL,
    created_at REAL NOT NULL,
    stop_id TEXT NOT NULL,
    stop_name TEXT NOT NULL,
    distance_to_stop_m INTEGER
);
CREATE INDEX IF NOT EXISTS sightings_created_at ON sightings(created_at);
CREATE TABLE IF NOT EXISTS likes (
    sighting_id TEXT NOT NULL REFERENCES sightings(id) ON DELETE CASCADE,
    user_key TEXT NOT NULL REFERENCES users(key) ON DELETE CASCADE,
    PRIMARY KEY (sighting_id, user_key)
);
"""

SIGHTINGS_QUERY = """
SELECT s.*, COUNT(l.user_key) AS likes_count, COALESCE(MAX(l.user_key = :user_key), 0) AS liked_by_me
FROM sightings s LEFT JOIN likes l ON l.sighting_id = s.id
WHERE s.created_at >= :cutoff AND (:id IS NULL OR s.id = :id)
GROUP BY s.id
ORDER BY s.created_at DESC
LIMIT :limit
"""


def hash_password(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ITERATIONS).hex()


def sighting_cutoff() -> float:
    return time.time() - SIGHTING_TTL_HOURS * 60 * 60


def public_sighting(row: Any) -> dict[str, Any]:
    item = dict(row)
    del item["owner"]
    item["created_at"] = datetime.fromtimestamp(item["created_at"], timezone.utc).isoformat()
    item["liked_by_me"] = bool(item["liked_by_me"])
    return item


class Store:
    """All persistent data in one SQLite file; safe across threads and processes."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._read() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(SCHEMA)

    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        # Autocommit connection; _write opens BEGIN IMMEDIATE so read-then-write steps are atomic.
        with closing(sqlite3.connect(self.path, timeout=10, isolation_level=None)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            yield db

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        with self._read() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
            except BaseException:
                db.execute("ROLLBACK")
                raise
            db.execute("COMMIT")

    def _sightings(self, db: sqlite3.Connection, user_key: str | None, sighting_id: str | None = None) -> list[dict[str, Any]]:
        rows = db.execute(
            SIGHTINGS_QUERY,
            {"user_key": user_key, "cutoff": sighting_cutoff(), "id": sighting_id, "limit": MAX_SIGHTINGS},
        )
        return [public_sighting(row) for row in rows]

    def list_sightings(self, user_key: str | None = None) -> list[dict[str, Any]]:
        with self._read() as db:
            return self._sightings(db, user_key)

    def add_sighting(self, sighting: dict[str, Any]) -> None:
        with self._write() as db:
            db.execute("DELETE FROM sightings WHERE created_at < ?", (sighting_cutoff(),))
            db.execute(
                "INSERT INTO sightings (id, lat, lon, route, note, reporter, owner, created_at, stop_id, stop_name,"
                " distance_to_stop_m) VALUES (:id, :lat, :lon, :route, :note, :reporter, :owner, :created_at,"
                " :stop_id, :stop_name, :distance_to_stop_m)",
                sighting,
            )
            if sighting["owner"]:
                db.execute("UPDATE users SET sightings_count = sightings_count + 1 WHERE key = ?", (sighting["owner"],))

    def like_sighting(self, sighting_id: str, user_key: str) -> dict[str, Any]:
        """Records one like per account and gives the owner XP in the same transaction."""
        with self._write() as db:
            row = db.execute(
                "SELECT owner FROM sightings WHERE id = ? AND created_at >= ?", (sighting_id, sighting_cutoff())
            ).fetchone()
            if row is None:
                raise LookupError(sighting_id)
            if row["owner"] == user_key:
                raise ValueError("Du kan ikke bekrefte din egen observasjon.")
            added = db.execute("INSERT OR IGNORE INTO likes VALUES (?, ?)", (sighting_id, user_key)).rowcount
            if added and row["owner"]:
                db.execute(
                    "UPDATE users SET xp = xp + ?, likes_received = likes_received + 1 WHERE key = ?",
                    (XP_PER_LIKE, row["owner"]),
                )
            return self._sightings(db, user_key, sighting_id)[0]

    def create_user(self, username: str, password: str) -> dict[str, str]:
        salt = secrets.token_hex(16)
        password_hash = hash_password(password, salt)  # Slow on purpose, so keep it outside the write lock.
        try:
            with self._write() as db:
                db.execute(
                    "INSERT INTO users (key, username, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                    (username.casefold(), username, salt, password_hash, time.time()),
                )
        except sqlite3.IntegrityError:
            raise ValueError("Brukernavnet er allerede i bruk.") from None
        return {"username": username}

    def authenticate(self, username: str, password: str) -> dict[str, str] | None:
        with self._read() as db:
            user = db.execute("SELECT * FROM users WHERE key = ?", (username.casefold(),)).fetchone()
        if not user or not secrets.compare_digest(hash_password(password, user["salt"]), user["password_hash"]):
            return None
        return {"username": user["username"]}

    def stats(self, username: str) -> dict[str, int]:
        with self._read() as db:
            user = db.execute(
                "SELECT xp, likes_received, sightings_count FROM users WHERE key = ?", (username.casefold(),)
            ).fetchone()
        stats = dict(user) if user else {"xp": 0, "likes_received": 0, "sightings_count": 0}
        return {**stats, "level": int(math.sqrt(stats["xp"] / XP_PER_LIKE)) + 1}

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(24)
        now = time.time()
        with self._write() as db:
            db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, username.casefold(), now + SESSION_TTL_SECONDS))
        return token

    def get_session_user(self, token: str | None) -> dict[str, str] | None:
        if not token:
            return None
        with self._read() as db:
            row = db.execute(
                "SELECT u.username FROM sessions s JOIN users u ON u.key = s.user_key"
                " WHERE s.token = ? AND s.expires_at >= ?",
                (token, time.time()),
            ).fetchone()
        return {"username": row["username"]} if row else None

    def delete_session(self, token: str | None) -> None:
        if token:
            with self._write() as db:
                db.execute("DELETE FROM sessions WHERE token = ?", (token,))


transit_data = TransitData(DATA_DIR)
store = Store(DB_FILE)
# ponytail: in-memory and per client IP; resets on restart.
recent_requests: dict[tuple[str, str], deque[float]] = defaultdict(deque)
RATE_LOCK = threading.Lock()


class AppHandler(SimpleHTTPRequestHandler):
    timeout = REQUEST_TIMEOUT_SECONDS

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_get(parsed)
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            self.send_json({"error": "Forespørselen kommer fra en annen side."}, status=HTTPStatus.FORBIDDEN)
            return
        if parsed.path == "/api/sightings":
            self.handle_api_post_sighting()
            return
        if parsed.path.startswith("/api/sightings/") and parsed.path.endswith("/like"):
            self.handle_like_sighting(parsed.path)
            return
        if parsed.path == "/api/auth/register":
            self.handle_register()
            return
        if parsed.path == "/api/auth/login":
            self.handle_login()
            return
        if parsed.path == "/api/auth/logout":
            self.handle_logout()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def log_message(self, format: str, *args: Any) -> None:
        return

    def handle_api_get(self, parsed: Any) -> None:
        params = parse_qs(parsed.query)
        if parsed.path == "/api/config":
            self.send_json({"ttl_hours": SIGHTING_TTL_HOURS})
            return

        if parsed.path == "/api/me":
            user = self.current_user()
            stats = store.stats(user["username"]) if user else None
            self.send_json({"user": user, "stats": stats})
            return

        if parsed.path == "/api/sightings":
            self.send_json({"items": store.list_sightings(self.current_user_key())})
            return

        if parsed.path == "/api/stops/search":
            query = params.get("q", [""])[0]
            self.send_json({"items": transit_data.search_stops(query)})
            return

        if parsed.path == "/api/stops/nearby":
            try:
                lat = parse_coordinate(params.get("lat", [None])[0], 90)
                lon = parse_coordinate(params.get("lon", [None])[0], 180)
            except (TypeError, ValueError):
                self.send_json({"error": "lat and lon must be valid coordinates"}, status=HTTPStatus.BAD_REQUEST)
                return
            self.send_json({"items": transit_data.find_nearby_stops(lat, lon)})
            return

        if parsed.path == "/api/routes":
            query = params.get("q", [""])[0]
            self.send_json({"items": transit_data.search_routes(query)})
            return

        self.send_json({"error": "Unknown endpoint"}, status=HTTPStatus.NOT_FOUND)

    def handle_api_post_sighting(self) -> None:
        if self.reject_if_rate_limited("sighting"):
            return
        user = self.current_user()
        data = self.read_json_body()
        if data is None:
            return

        try:
            lat = parse_coordinate(data.get("lat"), 90)
            lon = parse_coordinate(data.get("lon"), 180)
            stop_name = clean_text(data.get("stop_name"), STOP_NAME_MAX)
            route = clean_text(data.get("route"), ROUTE_MAX)
            note = clean_text(data.get("note"), NOTE_MAX)
            stop_id = clean_text(data.get("stop_id"), STOP_ID_MAX)
        except (TypeError, ValueError):
            self.send_json({"error": "Ugyldig posisjon eller tekst."}, status=HTTPStatus.BAD_REQUEST)
            return

        nearby = transit_data.find_nearby_stops(lat, lon, limit=1)
        nearest = nearby[0] if nearby else None

        owner = user["username"].casefold() if user else None
        sighting = {
            "id": secrets.token_hex(16),
            "lat": lat,
            "lon": lon,
            "route": route,
            "note": note,
            "reporter": user["username"] if user else "Anonym",
            "owner": owner,
            "created_at": time.time(),
            "stop_id": stop_id or (nearest["id"] if nearest else ""),
            "stop_name": stop_name or (nearest["name"] if nearest else "Ukjent sted"),
            "distance_to_stop_m": nearest["distance_m"] if nearest else None,
        }
        store.add_sighting(sighting)
        self.send_json(public_sighting({**sighting, "likes_count": 0, "liked_by_me": 0}), status=HTTPStatus.CREATED)

    def handle_like_sighting(self, path: str) -> None:
        prefix = "/api/sightings/"
        suffix = "/like"
        sighting_id = path[len(prefix) : -len(suffix)]
        if not sighting_id:
            self.send_json({"error": "Ugyldig observasjon."}, status=HTTPStatus.BAD_REQUEST)
            return
        user_key = self.current_user_key()
        if not user_key:
            self.send_json({"error": "Logg inn for å bekrefte observasjoner."}, status=HTTPStatus.UNAUTHORIZED)
            return
        try:
            item = store.like_sighting(sighting_id, user_key)
        except LookupError:
            self.send_json({"error": "Fant ikke observasjonen."}, status=HTTPStatus.NOT_FOUND)
            return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        self.send_json({"item": item})

    def handle_register(self) -> None:
        if self.reject_if_rate_limited("register"):
            return
        data = self.read_json_body()
        if data is None:
            return
        username = compact_whitespace(str(data.get("username") or ""))
        password = str(data.get("password") or "")
        error = self.validate_credentials(username, password)
        if error:
            self.send_json({"error": error}, status=HTTPStatus.BAD_REQUEST)
            return
        try:
            user = store.create_user(username, password)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        token = store.create_session(user["username"])
        self.send_json({"user": user}, status=HTTPStatus.CREATED, cookie_token=token)

    def handle_login(self) -> None:
        if self.reject_if_rate_limited("login"):
            return
        data = self.read_json_body()
        if data is None:
            return
        username = compact_whitespace(str(data.get("username") or ""))
        password = str(data.get("password") or "")
        user = store.authenticate(username, password)
        if not user:
            self.send_json({"error": "Feil brukernavn eller passord."}, status=HTTPStatus.UNAUTHORIZED)
            return
        token = store.create_session(user["username"])
        self.send_json({"user": user}, cookie_token=token)

    def handle_logout(self) -> None:
        store.delete_session(self.cookie_value(SESSION_COOKIE))
        self.send_json({"ok": True}, clear_cookie=True)

    def validate_credentials(self, username: str, password: str) -> str | None:
        if len(username) < 3:
            return "Brukernavn må være minst 3 tegn."
        if len(username) > 24:
            return "Brukernavn kan ikke være lengre enn 24 tegn."
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        if any(char not in allowed for char in username):
            return "Brukernavn kan bare inneholde bokstaver, tall, bindestrek og understrek."
        if username.casefold() == "anonym":
            return "Brukernavnet er reservert."
        if len(password) < 6:
            return "Passord må være minst 6 tegn."
        try:
            password.encode("utf-8")
        except UnicodeEncodeError:
            return "Passordet inneholder ugyldige tegn."
        return None

    def reject_if_rate_limited(self, action: str) -> bool:
        limit, window = RATE_LIMITS[action]
        now = time.monotonic()
        with RATE_LOCK:
            hits = recent_requests[(action, self.client_ip())]
            while hits and hits[0] <= now - window:
                hits.popleft()
            if len(hits) < limit:
                hits.append(now)
                return False
        self.send_json({"error": "For mange forsøk. Vent litt og prøv igjen."}, status=HTTPStatus.TOO_MANY_REQUESTS)
        return True

    def read_json_body(self) -> dict[str, Any] | None:
        if self.headers.get_content_type() != "application/json":
            self.send_json({"error": "Content-Type must be application/json"}, status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = -1
        if not 0 <= content_length <= MAX_BODY_BYTES:
            self.send_json({"error": "Invalid or too large body"}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json({"error": "Invalid JSON"}, status=HTTPStatus.BAD_REQUEST)
            return None
        if not isinstance(data, dict):
            self.send_json({"error": "JSON body must be an object"}, status=HTTPStatus.BAD_REQUEST)
            return None
        return data

    def client_ip(self) -> str:
        # The server only listens on 127.0.0.1, so outside clients come through a reverse
        # proxy, and the last X-Forwarded-For entry is the address that proxy saw.
        forwarded = self.headers.get("X-Forwarded-For")
        return forwarded.split(",")[-1].strip() if forwarded else self.client_address[0]

    def current_user(self) -> dict[str, str] | None:
        return store.get_session_user(self.cookie_value(SESSION_COOKIE))

    def current_user_key(self) -> str | None:
        user = self.current_user()
        return user["username"].casefold() if user else None

    def cookie_value(self, key: str) -> str | None:
        header = self.headers.get("Cookie", "")
        for part in header.split(";"):
            piece = part.strip()
            if "=" not in piece:
                continue
            name, value = piece.split("=", 1)
            if name == key:
                return value
        return None

    def send_json(
        self,
        payload: dict[str, Any],
        status: HTTPStatus = HTTPStatus.OK,
        cookie_token: str | None = None,
        clear_cookie: bool = False,
    ) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        if cookie_token:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={cookie_token}; Max-Age={SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax{secure}",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax{secure}",
            )
        self.end_headers()
        self.wfile.write(raw)


class AppServer(ThreadingHTTPServer):
    connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()


def run() -> None:
    host = "127.0.0.1"
    port = 8080
    server = AppServer((host, port), AppHandler)
    print(f"Serving BeeWare on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()
