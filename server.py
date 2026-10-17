
from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import secrets
import threading
from collections import defaultdict
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

BUCKET_SIZE = 0.01
DEFAULT_CENTER = {"lat": 58.1467, "lon": 7.9956}
SIGHTING_TTL_HOURS = 3
MAX_SIGHTINGS = 500
STOP_SEARCH_LIMIT = 12
ROUTE_SEARCH_LIMIT = 12
NEARBY_STOP_LIMIT = 6
EARTH_RADIUS_KM = 6371.0
SESSION_COOKIE = "beeware_session"
CLIENT_COOKIE = "beeware_client"
SESSION_TTL_DAYS = 14
PBKDF2_ITERATIONS = 120_000
XP_PER_LIKE = 10


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
        self.stop_buckets: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
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
                self.stop_buckets[self._bucket_key(lat, lon)].append(stop)

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

    def _bucket_key(self, lat: float, lon: float) -> tuple[int, int]:
        return (round(lat / BUCKET_SIZE), round(lon / BUCKET_SIZE))

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
        base_bucket = self._bucket_key(lat, lon)
        candidates: list[tuple[float, dict[str, Any]]] = []
        for lat_offset in range(-2, 3):
            for lon_offset in range(-2, 3):
                bucket = (
                    base_bucket[0] + lat_offset,
                    base_bucket[1] + lon_offset,
                )
                for stop in self.stop_buckets.get(bucket, []):
                    distance_km = haversine_km(lat, lon, stop["lat"], stop["lon"])
                    candidates.append((distance_km, stop))

        candidates.sort(key=lambda item: item[0])
        nearby = []
        for distance_km, stop in candidates[:limit]:
            nearby.append(
                {
                    **stop,
                    "distance_m": int(distance_km * 1000),
                }
            )
        return nearby


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

    def serialize(self, item: dict[str, Any], client_id: str | None = None) -> dict[str, Any]:
        liked_by = item.get("liked_by") or []
        return {
            **item,
            "likes_count": len(liked_by),
            "liked_by_me": bool(client_id and client_id in liked_by),
        }

    def list_recent(self, client_id: str | None = None) -> list[dict[str, Any]]:
        with STORE_LOCK:
            items = self._active_items()
        return [self.serialize(item, client_id) for item in items]

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        with STORE_LOCK:
            sightings = self._active_items()
            sightings.insert(0, payload)
            write_json(self.path, sightings[:MAX_SIGHTINGS])
        return payload

    def like(self, sighting_id: str, client_id: str) -> dict[str, Any] | None:
        with STORE_LOCK:
            sightings = self._active_items()
            updated_item = None
            for item in sightings:
                if item.get("id") != sighting_id:
                    continue
                liked_by = item.setdefault("liked_by", [])
                if client_id not in liked_by:
                    liked_by.append(client_id)
                updated_item = item
                break
            if updated_item is None:
                return None
            write_json(self.path, sightings[:MAX_SIGHTINGS])
        return updated_item

    def stats_for_user(self, username: str) -> dict[str, int]:
        with STORE_LOCK:
            sightings = read_json(self.path)
        likes_received = sum(len(item.get("liked_by") or []) for item in sightings if item.get("reporter") == username)
        sightings_count = sum(1 for item in sightings if item.get("reporter") == username)
        xp = likes_received * XP_PER_LIKE
        level = max(1, int(math.sqrt(xp / XP_PER_LIKE)) + 1 if xp else 1)
        return {
            "xp": xp,
            "level": level,
            "likes_received": likes_received,
            "sightings_count": sightings_count,
        }


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

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(24)
        with STORE_LOCK:
            sessions = read_json(self.sessions_path)
            sessions[token] = {
                "username": username,
                "expires_at": (utc_now() + timedelta(days=SESSION_TTL_DAYS)).isoformat(),
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


class AppHandler(SimpleHTTPRequestHandler):
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
            self.send_json(
                {
                    "center": DEFAULT_CENTER,
                    "ttl_hours": SIGHTING_TTL_HOURS,
                }
            )
            return

        if parsed.path == "/api/me":
            user = self.current_user()
            stats = sighting_store.stats_for_user(user["username"]) if user else None
            self.send_json({"user": user, "stats": stats})
            return

        if parsed.path == "/api/sightings":
            self.send_json({"items": sighting_store.list_recent(self.current_client_id())})
            return

        if parsed.path == "/api/stops/search":
            query = params.get("q", [""])[0]
            self.send_json({"items": transit_data.search_stops(query)})
            return

        if parsed.path == "/api/stops/nearby":
            lat = self._get_float(params, "lat")
            lon = self._get_float(params, "lon")
            if lat is None or lon is None:
                self.send_json({"error": "lat and lon are required"}, status=HTTPStatus.BAD_REQUEST)
                return
            self.send_json({"items": transit_data.find_nearby_stops(lat, lon)})
            return

        if parsed.path == "/api/routes":
            query = params.get("q", [""])[0]
            self.send_json({"items": transit_data.search_routes(query)})
            return

        self.send_json({"error": "Unknown endpoint"}, status=HTTPStatus.NOT_FOUND)

    def handle_api_post_sighting(self) -> None:
        user = self.current_user()
        data = self.read_json_body()
        if data is None:
            return

        try:
            lat = float(data["lat"])
            lon = float(data["lon"])
        except (KeyError, TypeError, ValueError):
            self.send_json({"error": "lat and lon must be numbers"}, status=HTTPStatus.BAD_REQUEST)
            return

        stop_name = compact_whitespace(str(data.get("stop_name") or ""))
        route = compact_whitespace(str(data.get("route") or ""))
        note = compact_whitespace(str(data.get("note") or ""))

        nearby = transit_data.find_nearby_stops(lat, lon, limit=1)
        nearest = nearby[0] if nearby else None

        payload = {
            "id": f"sighting-{int(utc_now().timestamp() * 1000)}",
            "lat": lat,
            "lon": lon,
            "route": route,
            "note": note[:160],
            "reporter": user["username"][:40] if user else "Anonym",
            "created_at": utc_now().isoformat(),
            "stop_id": data.get("stop_id") or (nearest["id"] if nearest else ""),
            "stop_name": stop_name or (nearest["name"] if nearest else "Ukjent sted"),
            "distance_to_stop_m": nearest["distance_m"] if nearest else None,
            "liked_by": [],
        }
        sighting_store.add(payload)
        self.send_json(sighting_store.serialize(payload, self.current_client_id()), status=HTTPStatus.CREATED)

    def handle_like_sighting(self, path: str) -> None:
        prefix = "/api/sightings/"
        suffix = "/like"
        sighting_id = path[len(prefix) : -len(suffix)]
        if not sighting_id:
            self.send_json({"error": "Ugyldig observasjon."}, status=HTTPStatus.BAD_REQUEST)
            return
        item = sighting_store.like(sighting_id, self.current_client_id())
        if item is None:
            self.send_json({"error": "Fant ikke observasjonen."}, status=HTTPStatus.NOT_FOUND)
            return
        self.send_json({"item": sighting_store.serialize(item, self.current_client_id())})

    def handle_register(self) -> None:
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
        if len(password) < 6:
            return "Passord må være minst 6 tegn."
        return None

    def read_json_body(self) -> dict[str, Any] | None:
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, status=HTTPStatus.BAD_REQUEST)
            return None
        if not isinstance(data, dict):
            self.send_json({"error": "JSON body must be an object"}, status=HTTPStatus.BAD_REQUEST)
            return None
        return data

    def current_user(self) -> dict[str, str] | None:
        return auth_store.get_session_user(self.cookie_value(SESSION_COOKIE))

    def current_client_id(self) -> str:
        cached = getattr(self, "_client_cookie", None)
        if cached:
            return cached
        token = self.cookie_value(CLIENT_COOKIE) or secrets.token_urlsafe(18)
        self._client_cookie = token
        return token

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

    def _get_float(self, params: dict[str, list[str]], key: str) -> float | None:
        raw = params.get(key, [None])[0]
        if raw is None:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    def send_json(
        self,
        payload: dict[str, Any],
        status: HTTPStatus = HTTPStatus.OK,
        cookie_token: str | None = None,
        clear_cookie: bool = False,
    ) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        if cookie_token:
            max_age = SESSION_TTL_DAYS * 24 * 60 * 60
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={cookie_token}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax",
            )
        client_cookie = self.current_client_id()
        if self.cookie_value(CLIENT_COOKIE) != client_cookie:
            max_age = 365 * 24 * 60 * 60
            self.send_header(
                "Set-Cookie",
                f"{CLIENT_COOKIE}={client_cookie}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
            )
        self.end_headers()
        self.wfile.write(raw)


def run() -> None:
    host = "127.0.0.1"
    port = 8080
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f"Serving BeeWare on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()
