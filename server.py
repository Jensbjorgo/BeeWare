
from __future__ import annotations

import bisect
import csv
import hashlib
import heapq
import json
import math
import re
import secrets
import sqlite3
import threading
import time
from collections import Counter, defaultdict, deque
from collections.abc import Iterable, Iterator
from contextlib import closing, contextmanager, suppress
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
ROUTE_SEARCH_LIMIT = 20
NEARBY_STOP_LIMIT = 6
NEARBY_RADIUS_KM = 2.0
# The line search lists lines stopping within ROUTE_NEAR_KM of the report first, then those
# stopping within ROUTE_AREA_KM, such as the rest of Oslo or Trondheim.
ROUTE_NEAR_KM = 0.5
ROUTE_AREA_KM = 30.0
# WGS84, the datum of GTFS and GPS coordinates.
WGS84_A_KM = 6378.137
WGS84_F = 1 / 298.257223563
# Entur marks each stop with the GTFS route type that serves it.
VEHICLE_MODES = {
    "0": "trikk", "1": "T-bane", "2": "tog", "3": "buss", "4": "båt", "5": "kabeltrikk", "6": "taubane", "7": "kabelbane",
}
SESSION_COOKIE = "beeware_session"
SESSION_TTL_SECONDS = 14 * 24 * 60 * 60
PBKDF2_ITERATIONS = 120_000
XP_PER_LIKE = 10
HIDE_AFTER_REPORTS = 3  # A sighting reported by this many accounts is hidden for everyone.
MAX_BODY_BYTES = 4096
REQUEST_TIMEOUT_SECONDS = 10
MAX_CONNECTIONS = 64
STOP_NAME_MAX = 80
ROUTE_MAX = 100
NOTE_MAX = 160
STOP_ID_MAX = 64
# (requests, seconds) per client IP. Three reports per ten minutes means one
# client cannot push all active reports out of the 500-report store.
SIGHTING_ACTIONS = {"like": "bekrefte", "report": "rapportere", "delete": "slette"}  # action -> verb in messages
RATE_LIMITS = {"sighting": (3, 600), "login": (10, 300), "register": (3, 3600)}
# Map data and label glyphs come from OpenFreeMap; Kartverket is the fallback for older devices.
# Scripts, styles and the CSP-compatible map worker are all served locally.
CONTENT_SECURITY_POLICY = (
    "default-src 'self';"
    " img-src 'self' data: blob: https://cache.kartverket.no;"
    " connect-src 'self' https://tiles.openfreemap.org; worker-src 'self';"
    " frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance on the WGS84 ellipsoid (Andoyer-Lambert).

    Within 2 cm of the exact geodesic up to 2 km and 13 m anywhere in Norway; a sphere is off
    by up to 8 m and 5 km.
    """
    mid = math.radians((lat1 + lat2) / 2)
    half_dlat = math.radians((lat1 - lat2) / 2)
    half_dlon = math.radians((lon1 - lon2) / 2)
    s = (math.sin(half_dlat) * math.cos(half_dlon)) ** 2 + (math.cos(mid) * math.sin(half_dlon)) ** 2
    c = (math.cos(half_dlat) * math.cos(half_dlon)) ** 2 + (math.sin(mid) * math.sin(half_dlon)) ** 2
    if s == 0:
        return 0.0
    if c < 1e-9:  # Nearly opposite points, where the formula breaks down: half a meridian apart.
        return 20003.931458
    omega = math.atan(math.sqrt(s / c))
    r = math.sqrt(s * c) / omega
    h1 = (3 * r - 1) / (2 * c)
    h2 = (3 * r + 1) / (2 * s)
    return 2 * omega * WGS84_A_KM * (
        1
        + WGS84_F * h1 * (math.sin(mid) * math.cos(half_dlat)) ** 2
        - WGS84_F * h2 * (math.cos(mid) * math.sin(half_dlat)) ** 2
    )


def compact_whitespace(value: str) -> str:
    return " ".join(value.split())


def clean_text(value: Any, limit: int) -> str:
    return compact_whitespace(str(value or ""))[:limit]


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


def read_gtfs(path: Path) -> Iterator[dict[str, str]]:
    if not path.is_file():
        return
    # utf-8-sig: GTFS files may start with a byte order mark.
    with path.open(newline="", encoding="utf-8-sig") as handle:
        yield from csv.DictReader(handle)


class TransitData:
    """Stops and routes from a GTFS feed, such as Entur's feed for all of Norway.

    Users search for and pick stops: stations (location_type 1) and stops without a station.
    A station's platforms (quays) are its boarding points, so distances go to the nearest platform.
    """

    def __init__(self, data_dir: Path) -> None:
        self.stops_by_id: dict[str, dict[str, Any]] = {}
        self.search_index: list[tuple[str, dict[str, Any]]] = []
        self.points: list[tuple[float, float, str]] = []  # (lat, lon, stop id), sorted by latitude.
        self.point_lats: list[float] = []
        self.platforms: defaultdict[str, list[tuple[float, float]]] = defaultdict(list)  # stop id -> points
        self.route_index: list[dict[str, str]] = []
        self.stop_routes: defaultdict[str, set[str]] = defaultdict(set)  # stop id -> ids of lines stopping there
        self._load_stops(read_gtfs(data_dir / "stops.txt"))
        aliases = self._load_routes(read_gtfs(data_dir / "routes.txt"), read_gtfs(data_dir / "agency.txt"))
        # Written by update_data.py from every trip in the feed.
        for row in read_gtfs(data_dir / "stop_routes.txt"):
            if row.get("route_id") in aliases:
                self.stop_routes[row.get("stop_id") or ""].add(aliases[row["route_id"]])

    def _load_stops(self, rows: Iterable[dict[str, str]]) -> None:
        parsed = []
        for row in rows:
            try:
                stop = {
                    "id": compact_whitespace(row["stop_id"]),
                    "name": compact_whitespace(row["stop_name"]),
                    "lat": parse_coordinate(row["stop_lat"], 90),
                    "lon": parse_coordinate(row["stop_lon"], 180),
                    "platform": row.get("platform_code") or "",
                    "description": compact_whitespace(row.get("stop_desc") or ""),
                    "mode": VEHICLE_MODES.get(row.get("vehicle_type") or "", ""),
                }
            except (AttributeError, KeyError, TypeError, ValueError):
                continue  # Missing columns, short rows and invalid coordinates are skipped.
            parsed.append((row.get("location_type") or "0", row.get("parent_station") or "", stop))
        stations = {stop["id"]: stop for kind, _, stop in parsed if kind == "1"}
        for kind, parent, stop in parsed:
            if kind == "1" or (kind == "0" and parent not in stations):
                self.stops_by_id[stop["id"]] = stop
            if kind == "0":  # Entrances, nodes and boarding areas (2-4) are not boarding points.
                self.points.append((stop["lat"], stop["lon"], parent if parent in stations else stop["id"]))
        measured = {stop_id for _, _, stop_id in self.points}
        self.points += [(s["lat"], s["lon"], s["id"]) for s in stations.values() if s["id"] not in measured]
        self.points.sort()
        self.point_lats = [point[0] for point in self.points]
        for lat, lon, stop_id in self.points:
            self.platforms[stop_id].append((lat, lon))
        self.search_index = [
            (f"{stop['name']} {stop['description']} {stop['platform']}".casefold(), stop)
            for stop in self.stops_by_id.values()
        ]

    def _load_routes(self, rows: Iterable[dict[str, str]], agencies: Iterable[dict[str, str]]) -> dict[str, str]:
        """Loads the line list and returns each route id mapped to the id of the line it is listed as."""
        agency_names = {row.get("agency_id") or "": compact_whitespace(row.get("agency_name") or "") for row in agencies}
        seen: dict[tuple[str, str, str], str] = {}
        aliases: dict[str, str] = {}
        for row in rows:
            route_id = row.get("route_id") or ""
            short_name = compact_whitespace(row.get("route_short_name") or "")
            long_name = compact_whitespace(row.get("route_long_name") or "")
            agency = agency_names.get(row.get("agency_id") or "", "")
            key = (short_name.casefold(), long_name.casefold(), agency.casefold())
            if not (short_name or long_name):  # GTFS requires one of the names.
                continue
            if key in seen:  # Identical lines are listed once.
                aliases[route_id] = seen[key]
                continue
            seen[key] = aliases[route_id] = route_id
            name = f"{short_name} {long_name}".strip()
            self.route_index.append(
                {
                    "id": route_id,
                    "short_name": short_name,
                    "long_name": long_name,
                    "agency": agency,
                    "label": f"{name} · {agency}" if agency else name,
                }
            )
        # What a report says: number and operator, or the full label where an operator has two lines
        # with the same number, such as two line 48s around Kristiansand.
        numbers = Counter((route["short_name"].casefold(), route["agency"].casefold()) for route in self.route_index)
        for route in self.route_index:
            unique = route["short_name"] and numbers[route["short_name"].casefold(), route["agency"].casefold()] == 1
            route["value"] = " · ".join(filter(None, (route["short_name"], route["agency"]))) if unique else route["label"]
        return aliases

    def search_stops(
        self, query: str, near: tuple[float, float] | None = None, limit: int = STOP_SEARCH_LIMIT
    ) -> list[dict[str, Any]]:
        """Exact names first, then names with a word that starts with the query, then the rest.

        Within each group the stops closest to `near` come first, so "sentrum" finds the nearest town.
        With `near`, a stop's position and distance are those of its platform closest to `near`.
        """
        needle = compact_whitespace(query).casefold()
        if not needle:
            return []
        word_start = re.compile(r"\b" + re.escape(needle))
        scored = []
        for haystack, stop in self.search_index:
            if needle not in haystack:
                continue
            name = stop["name"].casefold()
            if len(needle) == 1 and name != needle:
                continue  # A single letter only finds the stop with exactly that name, such as Å in Lofoten.
            quality = 0 if name == needle else 1 if word_start.search(name) else 2
            distance = 0.0
            if near:
                distance, lat, lon = min(
                    (distance_km(near[0], near[1], lat, lon), lat, lon) for lat, lon in self.platforms[stop["id"]]
                )
                stop = {**stop, "lat": lat, "lon": lon, "distance_m": round(distance * 1000)}
            scored.append((quality, distance, name, stop["id"], stop))
        return [item[-1] for item in heapq.nsmallest(limit, scored, key=lambda item: item[:4])]

    def search_routes(
        self, query: str, near: tuple[float, float] | None = None, limit: int = ROUTE_SEARCH_LIMIT
    ) -> list[dict[str, str]]:
        """Every word must match, as in "31 AtB".

        Line numbers that start with one of the words come before other matches. Within those groups,
        lines stopping near `near` come first, then the rest of the area, then the rest of Norway;
        and within each of these an equal line number before longer ones, then the closest line.
        """
        words = compact_whitespace(query).casefold().split()
        if not words:
            return []
        route_km: dict[str, float] = {}  # line id -> km from `near` to its closest stop
        for stop_id, km in (self._nearest_platforms(*near, ROUTE_AREA_KM) if near else {}).items():
            for route_id in self.stop_routes.get(stop_id, ()):
                if km < route_km.get(route_id, math.inf):
                    route_km[route_id] = km

        def rank(route: dict[str, str]) -> tuple[bool, int, int, float, str]:
            short_name = route["short_name"].casefold()
            number = 0 if short_name in words else 1 if short_name.startswith(tuple(words)) else 2
            km = route_km.get(route["id"], math.inf)
            area = 0 if km <= ROUTE_NEAR_KM else 1 if km <= ROUTE_AREA_KM else 2
            return (number == 2, area, number, km, route["label"])

        matches = [route for route in self.route_index if all(word in route["label"].casefold() for word in words)]
        return heapq.nsmallest(limit, matches, key=rank)

    def find_nearby_stops(
        self, lat: float, lon: float, limit: int = NEARBY_STOP_LIMIT
    ) -> list[dict[str, Any]]:
        nearest = self._nearest_platforms(lat, lon, NEARBY_RADIUS_KM)
        return [
            {**self.stops_by_id[stop_id], "distance_m": round(distance * 1000)}
            for stop_id, distance in heapq.nsmallest(limit, nearest.items(), key=lambda item: item[1])
        ]

    def _nearest_platforms(self, lat: float, lon: float, radius_km: float) -> dict[str, float]:
        """Stops with a platform within the radius, mapped to the distance to their nearest one in km."""
        # Only boarding points inside this latitude and longitude band can be within the radius.
        # ponytail: the band ignores the 180th meridian, which no Norwegian stop is near.
        # A degree of latitude is shortest at the equator (radius a(1-f)²), so the band is never too narrow.
        dlat = math.degrees(radius_km / (WGS84_A_KM * (1 - WGS84_F) ** 2))
        dlon = dlat / math.cos(math.radians(min(abs(lat) + dlat, 89.9)))
        first = bisect.bisect_left(self.point_lats, lat - dlat)
        last = bisect.bisect_right(self.point_lats, lat + dlat)
        nearest: dict[str, float] = {}
        for point_lat, point_lon, stop_id in self.points[first:last]:
            if abs(point_lon - lon) <= dlon:
                distance = distance_km(lat, lon, point_lat, point_lon)
                if distance <= radius_km and distance < nearest.get(stop_id, math.inf):
                    nearest[stop_id] = distance
        return nearest


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
CREATE TABLE IF NOT EXISTS reports (
    sighting_id TEXT NOT NULL REFERENCES sightings(id) ON DELETE CASCADE,
    user_key TEXT NOT NULL REFERENCES users(key) ON DELETE CASCADE,
    PRIMARY KEY (sighting_id, user_key)
);
"""

# Visible sightings: not expired, not reported by this user and not hidden by reports.
SIGHTINGS_QUERY = """
SELECT s.*, COUNT(l.user_key) AS likes_count, COALESCE(MAX(l.user_key = :user_key), 0) AS liked_by_me,
    COALESCE(s.owner = :user_key, 0) AS mine
FROM sightings s LEFT JOIN likes l ON l.sighting_id = s.id
WHERE s.created_at >= :cutoff AND (:id IS NULL OR s.id = :id)
    AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.sighting_id = s.id AND r.user_key = :user_key)
    AND (SELECT COUNT(*) FROM reports r WHERE r.sighting_id = s.id) < :hide_after
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
    item["mine"] = bool(item["mine"])
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
            {
                "user_key": user_key, "cutoff": sighting_cutoff(), "id": sighting_id,
                "hide_after": HIDE_AFTER_REPORTS, "limit": MAX_SIGHTINGS,
            },
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
            owner = self._visible_owner(db, sighting_id, user_key)
            if owner == user_key:
                raise ValueError("Du kan ikke bekrefte din egen observasjon.")
            added = db.execute("INSERT OR IGNORE INTO likes VALUES (?, ?)", (sighting_id, user_key)).rowcount
            if added and owner:
                db.execute(
                    "UPDATE users SET xp = xp + ?, likes_received = likes_received + 1 WHERE key = ?",
                    (XP_PER_LIKE, owner),
                )
            return self._sightings(db, user_key, sighting_id)[0]

    def report_sighting(self, sighting_id: str, user_key: str) -> None:
        """Hides the sighting for this user at once, and for everyone once HIDE_AFTER_REPORTS accounts report it."""
        with self._write() as db:
            if self._visible_owner(db, sighting_id, user_key) == user_key:
                raise ValueError("Du kan slette din egen observasjon i stedet.")
            db.execute("INSERT OR IGNORE INTO reports VALUES (?, ?)", (sighting_id, user_key))

    def delete_sighting(self, sighting_id: str, user_key: str) -> None:
        """Deletes the user's own sighting with its likes and reports; XP already given stays."""
        with self._write() as db:
            if not db.execute("DELETE FROM sightings WHERE id = ? AND owner = ?", (sighting_id, user_key)).rowcount:
                raise LookupError(sighting_id)

    def _visible_owner(self, db: sqlite3.Connection, sighting_id: str, user_key: str) -> str | None:
        """The owner of a sighting this user can see; expired, deleted or hidden ones raise LookupError."""
        if not self._sightings(db, user_key, sighting_id):
            raise LookupError(sighting_id)
        return db.execute("SELECT owner FROM sightings WHERE id = ?", (sighting_id,)).fetchone()["owner"]

    def create_user(self, username: str, password: str) -> str:
        """Creates the account and its first session in one transaction and returns the session token."""
        salt = secrets.token_hex(16)
        password_hash = hash_password(password, salt)  # Slow on purpose, so keep it outside the write lock.
        with self._write() as db:
            try:
                db.execute(
                    "INSERT INTO users (key, username, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                    (username.casefold(), username, salt, password_hash, time.time()),
                )
            except sqlite3.IntegrityError:
                raise ValueError("Brukernavnet er allerede i bruk.") from None
            return self._new_session(db, username)

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
        level = int(math.sqrt(stats["xp"] / XP_PER_LIKE)) + 1
        return {
            **stats,
            "level": level,
            "level_start_xp": (level - 1) ** 2 * XP_PER_LIKE,
            "next_level_xp": level ** 2 * XP_PER_LIKE,
        }

    def _new_session(self, db: sqlite3.Connection, username: str) -> str:
        token = secrets.token_urlsafe(24)
        now = time.time()
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, username.casefold(), now + SESSION_TTL_SECONDS))
        return token

    def create_session(self, username: str) -> str:
        with self._write() as db:
            return self._new_session(db, username)

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
    static_file = False  # One request per handler: the server speaks HTTP/1.0.

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        self.dispatch(self.route_get)

    def do_POST(self) -> None:  # noqa: N802
        self.dispatch(self.route_post)

    def do_HEAD(self) -> None:  # noqa: N802
        self.dispatch(self.route_get)  # send_json and send_head leave out the body for HEAD.

    def send_head(self) -> Any:
        try:
            return super().send_head()
        except ValueError:  # A path with a null byte, such as "/%00", names no file.
            self.send_error(HTTPStatus.NOT_FOUND)
            return None

    def dispatch(self, route: Any) -> None:
        """Gives every request an answer, also when the URL, the body read or the database fails."""
        try:
            parsed = urlparse(self.path)
        except ValueError:  # A request target such as "http://[".
            self.send_json({"error": "Ugyldig adresse."}, status=HTTPStatus.BAD_REQUEST)
            return
        try:
            route(parsed)
        except sqlite3.OperationalError:  # Still locked after the 10 s busy wait, or disk trouble.
            self.send_json({"error": "Serveren er opptatt. Prøv igjen."}, status=HTTPStatus.SERVICE_UNAVAILABLE)
        except TimeoutError:  # The client sent its body too slowly.
            self.send_json({"error": "Forespørselen tok for lang tid."}, status=HTTPStatus.REQUEST_TIMEOUT)
        except ConnectionError:
            raise  # The client is gone, so there is no one to answer.
        except Exception:
            self.server.handle_error(self.request, self.client_address)  # Prints the traceback.
            self.send_json({"error": "Noe gikk galt på serveren."}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def route_get(self, parsed: Any) -> None:
        if parsed.path.startswith("/api/"):
            self.handle_api_get(parsed)
            return
        if parsed.path == "/":
            self.path = "/index.html"
        self.static_file = True
        if self.command == "HEAD":
            super().do_HEAD()
        else:
            super().do_GET()

    def end_headers(self) -> None:
        # Every response, static files and errors included, refuses framing and MIME sniffing.
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.static_file:  # Browsers check for a newer version before they use a cached copy.
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def route_post(self, parsed: Any) -> None:
        origin = self.headers.get("Origin")
        try:
            foreign = bool(origin) and urlparse(origin).netloc != self.headers.get("Host")
        except ValueError:  # An unparsable Origin such as "http://[" counts as foreign.
            foreign = True
        if foreign:
            self.send_json({"error": "Forespørselen kommer fra en annen side."}, status=HTTPStatus.FORBIDDEN)
            return
        if parsed.path == "/api/sightings":
            self.handle_api_post_sighting()
            return
        parts = parsed.path.split("/")  # "/api/sightings/<id>/like" -> ["", "api", "sightings", id, "like"]
        if len(parts) == 5 and parts[:3] == ["", "api", "sightings"] and parts[4] in SIGHTING_ACTIONS:
            self.handle_sighting_action(parts[3], parts[4])
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
        self.send_json({"error": "Ukjent adresse."}, status=HTTPStatus.NOT_FOUND)

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
            try:
                near = (parse_coordinate(params["lat"][0], 90), parse_coordinate(params["lon"][0], 180))
            except (KeyError, ValueError):
                near = None  # The position only ranks the results; without it they are sorted by name.
            self.send_json({"items": transit_data.search_stops(params.get("q", [""])[0], near)})
            return

        if parsed.path == "/api/stops/nearby":
            try:
                lat = parse_coordinate(params.get("lat", [None])[0], 90)
                lon = parse_coordinate(params.get("lon", [None])[0], 180)
            except (TypeError, ValueError):
                self.send_json({"error": "Ugyldig posisjon."}, status=HTTPStatus.BAD_REQUEST)
                return
            self.send_json({"items": transit_data.find_nearby_stops(lat, lon)})
            return

        if parsed.path == "/api/routes":
            try:
                near = (parse_coordinate(params["lat"][0], 90), parse_coordinate(params["lon"][0], 180))
            except (KeyError, ValueError):
                near = None  # The position only ranks the results.
            self.send_json({"items": transit_data.search_routes(params.get("q", [""])[0], near)})
            return

        self.send_json({"error": "Ukjent adresse."}, status=HTTPStatus.NOT_FOUND)

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
        # A known stop ID wins; without a typed name the nearest stop fills in both ID and name.
        stop = transit_data.stops_by_id.get(stop_id) or (None if stop_name else nearest)

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
            "stop_id": stop["id"] if stop else "",
            "stop_name": stop["name"] if stop else stop_name or "Ukjent sted",
            "distance_to_stop_m": nearest["distance_m"] if nearest else None,
        }
        store.add_sighting(sighting)
        self.send_json(
            public_sighting({**sighting, "likes_count": 0, "liked_by_me": 0, "mine": bool(owner)}),
            status=HTTPStatus.CREATED,
        )

    def handle_sighting_action(self, sighting_id: str, action: str) -> None:
        if not sighting_id:
            self.send_json({"error": "Ugyldig observasjon."}, status=HTTPStatus.BAD_REQUEST)
            return
        user_key = self.current_user_key()
        if not user_key:
            verb = SIGHTING_ACTIONS[action]
            self.send_json({"error": f"Logg inn for å {verb} observasjoner."}, status=HTTPStatus.UNAUTHORIZED)
            return
        act = {"like": store.like_sighting, "report": store.report_sighting, "delete": store.delete_sighting}[action]
        try:
            item = act(sighting_id, user_key)
        except LookupError:
            self.send_json({"error": "Fant ikke observasjonen."}, status=HTTPStatus.NOT_FOUND)
            return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        self.send_json({"item": item} if item else {"ok": True})

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
            token = store.create_user(username, password)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        self.send_json({"user": {"username": username}}, status=HTTPStatus.CREATED, cookie_token=token)

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
            return "Brukernavn kan bare inneholde a–z, tall, bindestrek og understrek."
        if username.casefold() == "anonym":
            return "Brukernavnet er reservert."
        if len(password) < 6:
            return "Passord må være minst 6 tegn."
        return None

    def reject_if_rate_limited(self, action: str) -> bool:
        limit, window = RATE_LIMITS[action]
        now = time.monotonic()
        with RATE_LOCK:
            # ponytail: sweeps every client per call; fine for this traffic, use a timed sweep if it grows.
            for key in [key for key, hits in recent_requests.items() if hits[-1] <= now - RATE_LIMITS[key[0]][1]]:
                del recent_requests[key]
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
            self.send_json({"error": "Forespørselen må være JSON."}, status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = -1
        if not 0 <= content_length <= MAX_BODY_BYTES:
            self.send_json({"error": "Forespørselen er for stor."}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body.decode("utf-8"))
            json.dumps(data, ensure_ascii=False).encode("utf-8")  # Rejects lone surrogates such as "\ud800".
        except ValueError:  # Covers bad UTF-8, invalid JSON and the surrogate check.
            self.send_json({"error": "Ugyldig JSON."}, status=HTTPStatus.BAD_REQUEST)
            return None
        if not isinstance(data, dict):
            self.send_json({"error": "Ugyldig JSON."}, status=HTTPStatus.BAD_REQUEST)
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
        if self.command != "HEAD":
            self.wfile.write(raw)


class AppServer(ThreadingHTTPServer):
    connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.connection_slots.acquire(blocking=False):
            self.refuse(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:  # The worker thread never started, so it cannot free its slot.
            self.connection_slots.release()
            self.handle_error(request, client_address)
            self.refuse(request)

    def refuse(self, request: Any) -> None:
        with suppress(OSError):
            request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        self.shutdown_request(request)

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()


def run() -> None:
    host = "127.0.0.1"
    port = 8080
    server = AppServer((host, port), AppHandler)
    print(f"Serving BeeWare on http://{host}:{port} with {len(transit_data.stops_by_id)} stops"
          f" and {len(transit_data.route_index)} routes")
    server.serve_forever()


if __name__ == "__main__":
    run()
