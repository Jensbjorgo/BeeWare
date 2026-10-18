from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

# Starts the real server on a free port and gives each snippet a small HTTP client.
HTTP_PRELUDE = """
import http.client, json, threading, time
import server
httpd = server.AppServer(("127.0.0.1", 0), server.AppHandler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

def request(method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1])
    raw = body if isinstance(body, str) or body is None else json.dumps(body)
    connection.request(method, path, body=raw, headers={"Content-Type": "application/json", **(headers or {})})
    response = connection.getresponse()
    payload = response.read()
    cookies = response.headers.get_all("Set-Cookie") or []
    connection.close()
    return response.status, json.loads(payload) if payload.startswith(b"{") else None, cookies

def session(cookies):
    return {"Cookie": cookies[0].split(";")[0]}

def sql(query, *args):
    with server.store._write() as db:
        return db.execute(query, args).fetchall()
"""


def run_in_copy(test, code, data=None):
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory)
        shutil.copy(ROOT / "server.py", target / "server.py")
        shutil.copytree(ROOT / "web", target / "web")
        (target / "data").mkdir()
        for name, text in (data or {}).items():
            (target / "data" / name).write_text(text, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-c", HTTP_PRELUDE + code],
            cwd=target, capture_output=True, text=True,
        )
        test.assertEqual(result.returncode, 0, result.stderr)


class FreshCheckoutTests(unittest.TestCase):
    def test_startup_without_local_data_and_auth_lifecycle(self):
        run_in_copy(self, """
assert server.transit_data.search_stops('sentrum') == []
assert server.transit_data.search_routes('') == []
assert server.transit_data.find_nearby_stops(58.15, 8.0) == []
assert server.store.list_sightings() == []
auth = server.store
auth.create_user('tester', 'test-password')
assert auth.authenticate('tester', 'wrong') is None
assert auth.authenticate('tester', 'test-password') == {'username': 'tester'}
token = auth.create_session('tester')
assert auth.get_session_user(token) == {'username': 'tester'}
auth.delete_session(token)
assert auth.get_session_user(token) is None
assert sql("SELECT * FROM sessions WHERE token = ?", token) == []
""")

    def test_gtfs_search_and_nearest_stop(self):
        # A byte order mark, bad coordinates and short rows must not stop the server.
        partial = "".join(f"p{i},Sentrum park {i},58.1,8.1\n" for i in range(12))
        stops = f"\ufeffstop_id,stop_name,stop_lat,stop_lon\n{partial}1,Sentrum,58.15,8.0\nbad,Inf,inf,8\nnan,NaN,nan,8\nshort,Kort\n"
        run_in_copy(self, """
data = server.transit_data
assert sorted(data.stops_by_id) == sorted([*(f"p{i}" for i in range(12)), "1"])
assert data.search_stops('sentrum')[0]['id'] == '1'  # The exact name beats 12 partial matches.
assert data.search_routes('10')[0]['long_name'] == 'Sentrum'
assert data.search_routes('fly')[0]['label'] == 'Flybuss'
assert data.find_nearby_stops(58.15, 8.0)[0]['distance_m'] == 0
""", data={
            "stops.txt": stops,
            "routes.txt": "\ufeffroute_id,route_short_name,route_long_name\n1,10,Sentrum\n2,,Flybuss\n",
        })


    def test_national_feed_with_stations_platforms_and_agencies(self):
        # Entur's feed for all of Norway: stations (type 1) group their platforms (type 0).
        stops = """stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code
NSR:StopPlace:1,Jernbanetorget,59.9115,10.7500,1,,
NSR:Quay:11,Jernbanetorget,59.9110,10.7510,0,NSR:StopPlace:1,A
NSR:Quay:12,Jernbanetorget,59.9120,10.7490,0,NSR:StopPlace:1,B
NSR:Entrance:9,Inngang,59.9111,10.7511,2,NSR:StopPlace:1,
NSR:StopPlace:2,Sentrum,63.4305,10.3951,1,,
NSR:Quay:21,Sentrum,63.4300,10.3950,0,NSR:StopPlace:2,
NSR:StopPlace:3,Sentrum,59.9130,10.7400,1,,
NSR:StopPlace:4,Sentrum,59.9131,10.7402,1,,
NSR:StopPlace:5,Lørenskog sentrum,59.9270,10.9550,1,,
NSR:StopPlace:6,Sentrumsgården,59.9135,10.7410,1,,
NSR:StopPlace:7,Sentrum fergeleie,59.2000,10.4000,1,,
"""
        routes = """route_id,agency_id,route_short_name,route_long_name
RUT:Line:31,RUT,31,Tonsenhagen - Snaroya
ATB:Line:31,ATB,31,Lade - Tiller
RUT:Line:310,RUT,310,Ski - Oslo
"""
        agencies = "agency_id,agency_name\nRUT,Ruter\nATB,AtB\n"
        run_in_copy(self, """
data = server.transit_data
assert sorted(data.stops_by_id) == [f"NSR:StopPlace:{i}" for i in range(1, 8)]
assert [s["id"] for s in data.search_stops("jernbanetorget")] == ["NSR:StopPlace:1"]
trondheim, oslo = (63.43, 10.39), (59.91, 10.75)
# Exact names first, then names with a word starting "sentrum" by distance, then the rest.
# The two Oslo stations named Sentrum, a few metres apart, show as one.
assert [s["id"] for s in data.search_stops("sentrum", oslo)] == [
    "NSR:StopPlace:4", "NSR:StopPlace:2", "NSR:StopPlace:6", "NSR:StopPlace:5", "NSR:StopPlace:7",
], data.search_stops("sentrum", oslo)
first, second = [s["id"] for s in data.search_stops("sentrum", trondheim)][:2]
assert first == "NSR:StopPlace:2" and second in {"NSR:StopPlace:3", "NSR:StopPlace:4"}, (first, second)
assert "distance_m" not in data.search_stops("sentrum")[0]
# Distances go to the nearest platform, not the station's centre or an entrance.
nearest = data.find_nearby_stops(59.9110, 10.7510)
assert [(s["id"], s["distance_m"]) for s in nearest[:1]] == [("NSR:StopPlace:1", 0)], nearest
assert [s["id"] for s in data.find_nearby_stops(59.9130, 10.7400)][:1] == ["NSR:StopPlace:3"]
labels = [r["label"] for r in data.search_routes("31")]
assert labels == ["31 Lade - Tiller · AtB", "31 Tonsenhagen - Snaroya · Ruter", "310 Ski - Oslo · Ruter"], labels
items = request("GET", "/api/stops/search?q=sentrum&lat=63.43&lon=10.39")[1]["items"]
assert items[0]["id"] == "NSR:StopPlace:2" and items[0]["distance_m"] == 260, items
assert request("GET", "/api/stops/search?q=sentrum&lat=nan&lon=10")[0] == 200
""", data={"stops.txt": stops, "routes.txt": routes, "agency.txt": agencies})


class RegressionTests(unittest.TestCase):
    def test_concurrent_writes_keep_every_report_and_user(self):
        run_in_copy(self, """
from concurrent.futures import ThreadPoolExecutor
def report(i):
    server.store.add_sighting({"id": str(i), "lat": 58, "lon": 8, "route": "", "note": "", "reporter": "Anonym",
                               "owner": None, "created_at": time.time(), "stop_id": "", "stop_name": "",
                               "distance_to_stop_m": None})
def register(i):
    try:
        server.store.create_user("same", f"password-{i}")
        return True
    except ValueError:
        return False
# result() re-raises any error from a worker thread, so a crash cannot pass unnoticed.
with ThreadPoolExecutor(60) as pool:
    results = [job.result() for job in [pool.submit(f, i) for i in range(30) for f in (report, register)]]
assert len(server.store.list_sightings()) == 30
assert results.count(True) == 1, results
assert sum(bool(server.store.authenticate("same", f"password-{i}")) for i in range(30)) == 1

# Other processes share the database file.
child = "import server, time\\nfor i in range(20): server.store.add_sighting(%r | {'id': f'%s-{i}'})"
fields = {"lat": 58, "lon": 8, "route": "", "note": "", "reporter": "Anonym", "owner": None,
          "created_at": time.time(), "stop_id": "", "stop_name": "", "distance_to_stop_m": None}
import subprocess, sys
children = [subprocess.Popen([sys.executable, "-c", child % (fields, n)]) for n in range(3)]
assert [c.wait() for c in children] == [0, 0, 0]
assert len(server.store.list_sightings()) == 90

# Ten accounts liking the same report at once, twice each, give exactly ten likes and 100 XP.
for i in range(10):
    sql("INSERT INTO users (key, username, salt, password_hash, created_at) VALUES (?, ?, '', '', 0)", f"u{i}", f"u{i}")
sql("UPDATE sightings SET owner = 'same' WHERE id = '0'")
with ThreadPoolExecutor(20) as pool:
    [job.result() for job in [pool.submit(server.store.like_sighting, "0", f"u{i % 10}") for i in range(20)]]
assert {s["id"]: s["likes_count"] for s in server.store.list_sightings()}["0"] == 10
assert server.store.stats("same")["xp"] == 100

# If giving XP fails, the like is rolled back with it.
sql("CREATE TRIGGER no_xp BEFORE UPDATE OF xp ON users BEGIN SELECT RAISE(ABORT, 'no xp'); END")
sql("UPDATE sightings SET owner = 'same' WHERE id = '1'")
try:
    server.store.like_sighting("1", "u0")
    raise AssertionError("the XP update should fail")
except server.sqlite3.IntegrityError:
    pass
assert sql("SELECT * FROM likes WHERE sighting_id = '1'") == []

# If creating the first session fails, the new account is rolled back too.
sql("CREATE TRIGGER no_sessions BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'no sessions'); END")
try:
    server.store.create_user("halfway", "secret1")
    raise AssertionError("the session insert should fail")
except server.sqlite3.IntegrityError:
    pass
assert sql("SELECT * FROM users WHERE key = 'halfway'") == []
""")

    def test_bad_requests_are_rejected_without_losing_data(self):
        run_in_copy(self, """
server.RATE_LIMITS["sighting"] = (100, 600)
assert request("POST", "/api/sightings", {"lat": 58.1, "lon": 8, "route": "x" * 500})[0] == 201
assert request("POST", "/api/sightings", '{"lat": 58, "lon": 8, "note": "\\\\ud800"}')[0] == 400
for lat in (91, True, "nan", None, 10 ** 309):
    assert request("POST", "/api/sightings", {"lat": lat, "lon": 8})[0] == 400, lat
assert request("GET", "/api/stops/nearby?lat=nan&lon=8")[0] == 400
assert request("POST", "/api/sightings", "{}", {"Content-Length": "99999"})[0] == 413
assert request("POST", "/api/sightings", "{}", {"Content-Length": "abc"})[0] == 413
assert request("POST", "/api/sightings", '{"lat": 58, "lon": 8}', {"Content-Type": "text/plain"})[0] == 415
assert request("POST", "/api/sightings", {"lat": 58, "lon": 8}, {"Origin": "http://evil.test"})[0] == 403
assert request("POST", "/api/sightings", {"lat": 58, "lon": 8}, {"Origin": "http://["})[0] == 403
server.store.create_user("alice", "secret1")
assert request("POST", "/api/auth/login", '{"username": "alice", "password": "\\\\ud800"}')[0] == 400
assert request("POST", "/api/nothing", {})[0] == 404
items = request("GET", "/api/sightings")[1]["items"]
assert len(items) == 1 and len(items[0]["route"]) == server.ROUTE_MAX
""")

    def test_rate_limits_report_spam_and_login_guessing(self):
        run_in_copy(self, """
server.recent_requests[("login", "gone")].append(0.0)  # An expired client is swept away.
statuses = [request("POST", "/api/sightings", {"lat": 58, "lon": 8})[0] for _ in range(4)]
assert ("login", "gone") not in server.recent_requests
assert statuses == [201, 201, 201, 429], statuses
logins = [request("POST", "/api/auth/login", {"username": "x", "password": "y"})[0] for _ in range(11)]
assert logins[-2:] == [401, 429], logins
# Behind the reverse proxy each client is counted by its own forwarded address.
other = {"X-Forwarded-For": "203.0.113.9"}
assert request("POST", "/api/sightings", {"lat": 58, "lon": 8}, other)[0] == 201
""")

    def test_sessions_are_cleaned_and_secure_behind_https(self):
        run_in_copy(self, """
server.store.create_user("old-user", "secret1")
sql("INSERT INTO sessions VALUES ('old', 'old-user', 0)")
assert server.store.get_session_user("old") is None
server.store.create_session("old-user")
assert sql("SELECT * FROM sessions WHERE token = 'old'") == []
cookies = request("POST", "/api/auth/register", {"username": "tester", "password": "secret1"},
                  {"X-Forwarded-Proto": "https"})[2]
assert cookies and all("Secure" in cookie for cookie in cookies), cookies
assert all("Secure" not in cookie for cookie in request("POST", "/api/auth/logout")[2])
""")

    def test_xp_is_kept_and_likes_need_another_logged_in_user(self):
        run_in_copy(self, """
alice = session(request("POST", "/api/auth/register", {"username": "alice", "password": "secret1"})[2])
bob = session(request("POST", "/api/auth/register", {"username": "bob", "password": "secret1"})[2])
assert request("POST", "/api/auth/register", {"username": "Anonym", "password": "secret1"})[0] == 400
first = request("POST", "/api/sightings", {"lat": 58, "lon": 8}, alice)[1]["id"]
second = request("POST", "/api/sightings", {"lat": 58, "lon": 8}, alice)[1]["id"]
assert first != second
assert request("POST", f"/api/sightings/{first}/like")[0] == 401
assert request("POST", f"/api/sightings/{first}/like", headers=alice)[0] == 400
item = request("POST", f"/api/sightings/{first}/like", headers=bob)[1]["item"]
request("POST", f"/api/sightings/{first}/like", headers=bob)
assert item["likes_count"] == 1 and item["liked_by_me"] and "liked_by" not in item
assert all("liked_by" not in item for item in request("GET", "/api/sightings")[1]["items"])
sql("UPDATE sightings SET created_at = 0")  # Both reports expire ...
assert request("POST", f"/api/sightings/{second}/like", headers=bob)[0] == 404
third = request("POST", "/api/sightings", {"lat": 58, "lon": 8}, alice)[1]["id"]
assert [row["id"] for row in sql("SELECT id FROM sightings")] == [third]  # ... and the next report deletes them; the XP stays.
stats = request("GET", "/api/me", headers=alice)[1]["stats"]
assert stats == {"xp": 10, "level": 2, "likes_received": 1, "sightings_count": 3}, stats
""")

    def test_nearest_stop_is_the_closest_one_and_names_match_ids(self):
        run_in_copy(self, """
data = server.transit_data
assert [stop["id"] for stop in data.find_nearby_stops(58.15, 8.0)] == ["east", "north"]
assert [stop["id"] for stop in data.find_nearby_stops(58.15, 8.0, limit=1)] == ["east"]
def report(**fields):
    item = request("POST", "/api/sightings", {"lat": 58.15, "lon": 8.0, **fields})[1]
    return item["stop_id"], item["stop_name"], item["distance_to_stop_m"]
assert report() == ("east", "Ost", 587)
assert report(stop_name="Mitt sted") == ("", "Mitt sted", 587)
assert report(stop_name="Feil navn", stop_id="north") == ("north", "Nord", 587)
""", data={"stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nnorth,Nord,58.165,8.0\neast,Ost,58.15,8.01\nfar,Fjern,59.0,8.0\n"})

    def test_every_response_refuses_framing_and_sniffing(self):
        run_in_copy(self, """
for path, status in (("/", 200), ("/app.js", 200), ("/api/config", 200), ("/missing.js", 404)):
    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1])
    connection.request("GET", path)
    response = connection.getresponse()
    assert response.status == status, (path, response.status)
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"], path
    assert response.headers["X-Frame-Options"] == "DENY", path
    assert response.headers["X-Content-Type-Options"] == "nosniff", path
""")

    def test_every_failure_still_gets_an_http_answer(self):
        run_in_copy(self, """
import socket
def raw(data):
    client = socket.create_connection(("127.0.0.1", httpd.server_address[1]))
    client.sendall(data)
    return client.recv(64)
assert raw(b"GET http://[ HTTP/1.0\\r\\n\\r\\n").startswith(b"HTTP/1.0 400")
assert raw(b"GET /%00 HTTP/1.0\\r\\n\\r\\n").startswith(b"HTTP/1.0 404")
assert raw(b"HEAD /%00 HTTP/1.0\\r\\n\\r\\n").startswith(b"HTTP/1.0 404")
assert raw(b"HEAD / HTTP/1.0\\r\\n\\r\\n").startswith(b"HTTP/1.0 200")
def locked(*args):
    raise server.sqlite3.OperationalError("database is locked")
server.store.add_sighting = locked
assert request("POST", "/api/sightings", {"lat": 58, "lon": 8})[0] == 503
server.store.list_sightings = lambda *args: 1 / 0
assert request("GET", "/api/sightings")[0] == 500
assert server.haversine_km(58.059, 8, -58.059, -172) > 20000  # Nearly opposite points must not crash.

# A worker thread that cannot start gives its connection slot back.
httpd.connection_slots = threading.BoundedSemaphore(1)
start = threading.Thread.start
threading.Thread.start = lambda self: 1 / 0
assert request("GET", "/api/config")[0] == 503
threading.Thread.start = start
assert request("GET", "/api/config")[0] == 200
assert request("HEAD", "/api/config")[:2] == (200, None)

# A full server says so instead of hanging up.
httpd.connection_slots = threading.BoundedSemaphore(1)
httpd.connection_slots.acquire()
assert request("GET", "/api/config")[0] == 503

# A body that never arrives gets 408 once the socket timeout runs out.
httpd.connection_slots.release()
server.AppHandler.timeout = 0.2
body_missing = b"POST /api/auth/login HTTP/1.0\\r\\nContent-Type: application/json\\r\\nContent-Length: 10\\r\\n\\r\\n"
assert raw(body_missing).startswith(b"HTTP/1.0 408")
""")
