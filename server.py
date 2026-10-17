
from __future__ import annotations

import csv
import hashlib
import heapq
import json
import math
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
WEB_DIR = BASE_DIR / "web"
STORAGE_DIR = BASE_DIR / "storage"
SIGHTINGS_FILE = STORAGE_DIR / "sightings.json"
USERS_FILE = STORAGE_DIR / "users.json"
SESSIONS_FILE = STORAGE_DIR / "sessions.json"

SIGHTING_TTL_HOURS = 3
MAX_SIGHTINGS = 500
STOP_SEARCH_LIMIT = 12
ROUTE_SEARCH_LIMIT = 12
NEARBY_STOP_LIMIT = 6
NEARBY_RADIUS_KM = 2.0
EARTH_RADIUS_KM = 6371.0
SESSION_COOKIE = "beeware_session"
SESSION_TTL_DAYS = 14
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


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso8601(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


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
    number = float(value)
    if not math.isfinite(number) or abs(number) > limit:
        raise ValueError("out of range")
    return number


# ponytail: one lock for all JSON stores in one process; move to SQLite if it outgrows that.
STORE_LOCK = threading.RLock()


def read_json(path: Path) -> Any:
    # A broken file raises instead of being treated as empty and overwritten.
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    raw = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temp = path.with_suffix(".tmp")
    temp.write_bytes(raw)
    os.replace(temp, path)


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


class SightingStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("[]\n", encoding="utf-8")

    def _active_items(self) -> list[dict[str, Any]]:
        cutoff = utc_now() - timedelta(hours=SIGHTING_TTL_HOURS)
        sightings = read_json(self.path)
        active = [item for item in sightings if parse_iso8601(item["created_at"]) >= cutoff]
        active.sort(key=lambda item: item["created_at"], reverse=True)
        return active[:MAX_SIGHTINGS]

    def serialize(self, item: dict[str, Any], user_key: str | None = None) -> dict[str, Any]:
        liked_by = item.get("liked_by") or []
        public = {key: value for key, value in item.items() if key not in ("liked_by", "owner")}
        return {
            **public,
            "likes_count": len(liked_by),
            "liked_by_me": bool(user_key and user_key in liked_by),
        }

    def list_recent(self, user_key: str | None = None) -> list[dict[str, Any]]:
        with STORE_LOCK:
            items = self._active_items()
        return [self.serialize(item, user_key) for item in items]

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        with STORE_LOCK:
            sightings = self._active_items()
            sightings.insert(0, payload)
            write_json(self.path, sightings[:MAX_SIGHTINGS])
        return payload

    def like(self, sighting_id: str, user_key: str) -> tuple[dict[str, Any], bool]:
        """Returns the sighting and whether this like is new."""
        with STORE_LOCK:
            sightings = self._active_items()
            item = next((item for item in sightings if item.get("id") == sighting_id), None)
            if item is None:
                raise LookupError(sighting_id)
            if item.get("owner") == user_key:
                raise ValueError("Du kan ikke bekrefte din egen observasjon.")
            liked_by = item.setdefault("liked_by", [])
            if user_key in liked_by:
                return item, False
            liked_by.append(user_key)
            write_json(self.path, sightings)
        return item, True


class AuthStore:
    def __init__(self, users_path: Path, sessions_path: Path) -> None:
        self.users_path = users_path
        self.sessions_path = sessions_path
        for path in (self.users_path, self.sessions_path):
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text("{}\n", encoding="utf-8")

    def _hash_password(self, password: str, salt_hex: str) -> str:
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            PBKDF2_ITERATIONS,
        )
        return digest.hex()

    def create_user(self, username: str, password: str) -> dict[str, str]:
        salt = secrets.token_hex(16)
        password_hash = self._hash_password(password, salt)
        key = username.casefold()
        with STORE_LOCK:
            users = read_json(self.users_path)
            if key in users:
                raise ValueError("Brukernavnet er allerede i bruk.")
            users[key] = {
                "username": username,
                "salt": salt,
                "password_hash": password_hash,
                "created_at": utc_now().isoformat(),
            }
            write_json(self.users_path, users)
        return {"username": username}

    def authenticate(self, username: str, password: str) -> dict[str, str] | None:
        users = read_json(self.users_path)
        user = users.get(username.casefold())
        if not user:
            return None
        password_hash = self._hash_password(password, user["salt"])
        if not secrets.compare_digest(password_hash, user["password_hash"]):
            return None
        return {"username": user["username"]}

    def add_stats(self, user_key: str, **increments: int) -> None:
        with STORE_LOCK:
            users = read_json(self.users_path)
            user = users.get(user_key)
            if user is None:
                return
            for field, amount in increments.items():
                user[field] = user.get(field, 0) + amount
            write_json(self.users_path, users)

    def stats(self, username: str) -> dict[str, int]:
        user = read_json(self.users_path).get(username.casefold(), {})
        xp = user.get("xp", 0)
        return {
            "xp": xp,
            "level": int(math.sqrt(xp / XP_PER_LIKE)) + 1,
            "likes_received": user.get("likes_received", 0),
            "sightings_count": user.get("sightings_count", 0),
        }

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(24)
        now = utc_now()
        with STORE_LOCK:
            sessions = {
                key: value
                for key, value in read_json(self.sessions_path).items()
                if parse_iso8601(value["expires_at"]) >= now
            }
            sessions[token] = {
                "username": username,
                "expires_at": (now + timedelta(days=SESSION_TTL_DAYS)).isoformat(),
            }
            write_json(self.sessions_path, sessions)
        return token

    def get_session_user(self, token: str | None) -> dict[str, str] | None:
        if not token:
            return None

        with STORE_LOCK:
            sessions = read_json(self.sessions_path)
            session = sessions.get(token)
            if not session:
                return None
            if parse_iso8601(session["expires_at"]) < utc_now():
                sessions.pop(token, None)
                write_json(self.sessions_path, sessions)
                return None
        return {"username": session["username"]}

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        with STORE_LOCK:
            sessions = read_json(self.sessions_path)
            if token in sessions:
                sessions.pop(token, None)
                write_json(self.sessions_path, sessions)


transit_data = TransitData(DATA_DIR)
sighting_store = SightingStore(SIGHTINGS_FILE)
auth_store = AuthStore(USERS_FILE, SESSIONS_FILE)
# ponytail: in-memory and per IP; resets on restart, and behind a proxy every
# client shares the proxy's IP, so read X-Forwarded-For there.
recent_requests: dict[tuple[str, str], deque[float]] = defaultdict(deque)


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
            stats = auth_store.stats(user["username"]) if user else None
            self.send_json({"user": user, "stats": stats})
            return

        if parsed.path == "/api/sightings":
            self.send_json({"items": sighting_store.list_recent(self.current_user_key())})
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
        payload = {
            "id": secrets.token_hex(16),
            "lat": lat,
            "lon": lon,
            "route": route,
            "note": note,
            "reporter": user["username"] if user else "Anonym",
            "owner": owner,
            "created_at": utc_now().isoformat(),
            "stop_id": stop_id or (nearest["id"] if nearest else ""),
            "stop_name": stop_name or (nearest["name"] if nearest else "Ukjent sted"),
            "distance_to_stop_m": nearest["distance_m"] if nearest else None,
            "liked_by": [],
        }
        sighting_store.add(payload)
        if owner:
            auth_store.add_stats(owner, sightings_count=1)
        self.send_json(sighting_store.serialize(payload, owner), status=HTTPStatus.CREATED)

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
            with STORE_LOCK:
                item, is_new = sighting_store.like(sighting_id, user_key)
                if is_new and item.get("owner"):
                    auth_store.add_stats(item["owner"], xp=XP_PER_LIKE, likes_received=1)
        except LookupError:
            self.send_json({"error": "Fant ikke observasjonen."}, status=HTTPStatus.NOT_FOUND)
            return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        self.send_json({"item": sighting_store.serialize(item, user_key)})

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
            user = auth_store.create_user(username, password)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        token = auth_store.create_session(user["username"])
        self.send_json({"user": user}, status=HTTPStatus.CREATED, cookie_token=token)

    def handle_login(self) -> None:
        if self.reject_if_rate_limited("login"):
            return
        data = self.read_json_body()
        if data is None:
            return
        username = compact_whitespace(str(data.get("username") or ""))
        password = str(data.get("password") or "")
        user = auth_store.authenticate(username, password)
        if not user:
            self.send_json({"error": "Feil brukernavn eller passord."}, status=HTTPStatus.UNAUTHORIZED)
            return
        token = auth_store.create_session(user["username"])
        self.send_json({"user": user}, cookie_token=token)

    def handle_logout(self) -> None:
        auth_store.delete_session(self.cookie_value(SESSION_COOKIE))
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
        with STORE_LOCK:
            hits = recent_requests[(action, self.client_address[0])]
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

    def current_user(self) -> dict[str, str] | None:
        return auth_store.get_session_user(self.cookie_value(SESSION_COOKIE))

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
            max_age = SESSION_TTL_DAYS * 24 * 60 * 60
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={cookie_token}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax{secure}",
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
