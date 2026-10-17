from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

# Starts the real server on a free port and gives each snippet a small HTTP client.
HTTP_PRELUDE = """
import http.client, json, threading
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
"""


def run_in_copy(test, code, stops=None):
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory)
        shutil.copy(ROOT / "server.py", target / "server.py")
        if stops:
            (target / "data").mkdir()
            (target / "data/stops.txt").write_text(stops, encoding="utf-8")
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
assert server.sighting_store.list_recent() == []
auth = server.auth_store
auth.create_user('tester', 'test-password')
assert auth.authenticate('tester', 'wrong') is None
assert auth.authenticate('tester', 'test-password') == {'username': 'tester'}
token = auth.create_session('tester')
assert auth.get_session_user(token) == {'username': 'tester'}
auth.delete_session(token)
assert auth.get_session_user(token) is None
assert server.read_json(auth.sessions_path) == {}
""")

    def test_gtfs_search_and_nearest_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            shutil.copy(ROOT / "server.py", target / "server.py")
            (target / "data").mkdir()
            (target / "data/stops.txt").write_text(
                "stop_id,stop_name,stop_lat,stop_lon\n1,Sentrum,58.15,8.0\n",
                encoding="utf-8",
            )
            (target / "data/routes.txt").write_text(
                "route_id,route_short_name,route_long_name\n1,10,Sentrum\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, "-c", """
import server
data = server.transit_data
assert data.search_stops('sent')[0]['id'] == '1'
assert data.search_routes('10')[0]['long_name'] == 'Sentrum'
assert data.find_nearby_stops(58.15, 8.0)[0]['distance_m'] == 0
"""],
                cwd=target, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


class RegressionTests(unittest.TestCase):
    def test_concurrent_writes_keep_every_report_and_user(self):
        run_in_copy(self, """
def report(i):
    server.sighting_store.add({"id": str(i), "lat": 58, "lon": 8, "reporter": "Anonym", "owner": None,
                               "created_at": server.utc_now().isoformat(), "liked_by": []})
def register(i):
    try:
        server.auth_store.create_user("same", f"password-{i}")
    except ValueError:
        pass
threads = [threading.Thread(target=f, args=(i,)) for i in range(30) for f in (report, register)]
[t.start() for t in threads]
[t.join() for t in threads]
assert len(server.sighting_store.list_recent()) == 30
assert sum(bool(server.auth_store.authenticate("same", f"password-{i}")) for i in range(30)) == 1
""")

    def test_bad_requests_are_rejected_without_losing_data(self):
        run_in_copy(self, """
server.RATE_LIMITS["sighting"] = (100, 600)
assert request("POST", "/api/sightings", {"lat": 58.1, "lon": 8, "route": "x" * 500})[0] == 201
assert request("POST", "/api/sightings", '{"lat": 58, "lon": 8, "note": "\\\\ud800"}')[0] == 400
for lat in (91, True, "nan", None):
    assert request("POST", "/api/sightings", {"lat": lat, "lon": 8})[0] == 400, lat
assert request("GET", "/api/stops/nearby?lat=nan&lon=8")[0] == 400
assert request("POST", "/api/sightings", "{}", {"Content-Length": "99999"})[0] == 413
assert request("POST", "/api/sightings", "{}", {"Content-Length": "abc"})[0] == 413
assert request("POST", "/api/sightings", '{"lat": 58, "lon": 8}', {"Content-Type": "text/plain"})[0] == 415
assert request("POST", "/api/sightings", {"lat": 58, "lon": 8}, {"Origin": "http://evil.test"})[0] == 403
items = request("GET", "/api/sightings")[1]["items"]
assert len(items) == 1 and len(items[0]["route"]) == server.ROUTE_MAX
""")

    def test_rate_limits_report_spam_and_login_guessing(self):
        run_in_copy(self, """
statuses = [request("POST", "/api/sightings", {"lat": 58, "lon": 8})[0] for _ in range(4)]
assert statuses == [201, 201, 201, 429], statuses
logins = [request("POST", "/api/auth/login", {"username": "x", "password": "y"})[0] for _ in range(11)]
assert logins[-2:] == [401, 429], logins
""")

    def test_sessions_are_cleaned_and_secure_behind_https(self):
        run_in_copy(self, """
auth = server.auth_store
server.write_json(auth.sessions_path, {"old": {"username": "x", "expires_at": "2000-01-01T00:00:00+00:00"}})
auth.create_session("x")
assert "old" not in server.read_json(auth.sessions_path)
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
server.write_json(server.SIGHTINGS_FILE, [])  # The report expires; the XP must stay.
stats = request("GET", "/api/me", headers=alice)[1]["stats"]
assert stats == {"xp": 10, "level": 2, "likes_received": 1, "sightings_count": 2}, stats
""")

    def test_nearest_stop_is_the_closest_one(self):
        run_in_copy(self, """
nearby = server.transit_data.find_nearby_stops(58.15, 8.0)
assert [stop["id"] for stop in nearby] == ["east"], nearby
""", stops="stop_id,stop_name,stop_lat,stop_lon\nnorth,Nord,58.17,8.0\neast,Ost,58.15,8.03\nfar,Fjern,59.0,8.0\n")
