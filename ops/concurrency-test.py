#!/usr/bin/env python3
"""Live concurrency acceptance test for a running Koe instance.

Phase 1 submits four jobs at once (two edge, two kitten) and samples
``/healthz`` plus every job's status until they finish. Phase 2 oversubscribes
on purpose (six short jobs) so the global cap is actually exercised: with only
four jobs a four-slot instance can never show a queue.

Reported per phase:

  queue      all submissions accepted, none dropped or double-counted
  caps       peak concurrent jobs per engine vs its ceiling, peak global active
  memory     ``docker stats`` and ``free -m`` while busy and after the burst

Run it on the instance so it can read the box's own memory:

    python3 ops/concurrency-test.py

It authenticates with ``KOE_API_KEY`` when set, otherwise with ``API_KEY`` from
the instance env file, otherwise it mints a free key (which is capped at three
per IP per day). Exit code 0 means every check passed.

    KOE_BASE=http://127.0.0.1:8080 python3 ops/concurrency-test.py
    KOE_API_KEY=koe_sk_... python3 ops/concurrency-test.py --no-oversubscribe
"""

import hashlib
import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

BASE = os.environ.get("KOE_BASE", "https://koe.kennedyazeru.space").rstrip("/")
KEY = os.environ.get("KOE_API_KEY", "").strip()
NO_DOCKER = os.environ.get("KOE_NO_DOCKER") == "1"

ENV_FILES = [
    "/home/ec2-user/koe-ops/koe.env",
    os.path.expanduser("~/koe-ops/koe.env"),
    os.path.expanduser("~/koe/.env"),
]

SENTENCE = (
    "The queue must hold four jobs at once without dropping any of them, and the per "
    "engine ceiling has to keep one sidecar from swallowing every worker slot while the "
    "other callers wait their turn. "
)
LONG_TEXT = SENTENCE * 2
SHORT_TEXT = "Short job for the oversubscription phase of the cap test."

PHASE1 = [
    ("edge", "en-US-EmmaNeural"),
    ("edge", "en-GB-RyanNeural"),
    ("kitten", "bella"),
    ("kitten", "jasper"),
]
PHASE2 = [("edge", "en-US-EmmaNeural")] * 6

IDLE = {"queued", "done", "failed", "expired", "cancelled"}


def req(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        r.add_header("content-type", "application/json")
    if KEY:
        r.add_header("x-api-key", KEY)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return x.status, json.loads(x.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()[:300]
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw}


def resolve_key():
    global KEY
    if KEY:
        return "KOE_API_KEY"
    for path in ENV_FILES:
        try:
            with open(path) as fh:
                for line in fh:
                    if line.startswith("API_KEY="):
                        value = line.split("=", 1)[1].strip().strip("\"'")
                        if value:
                            KEY = value
                            return "admin key from %s" % path
        except OSError:
            continue
    status, ch = req("GET", "/keys/challenge")
    if status != 200:
        sys.exit("cannot get a challenge: %s %s" % (status, ch))
    nonce, target = 0, ch["pow"]["leadingZeroHexChars"]
    while not hashlib.sha256((ch["challenge"] + str(nonce)).encode()).hexdigest().startswith("0" * target):
        nonce += 1
    status, body = req("POST", "/keys", {"challenge": ch["challenge"], "nonce": str(nonce)})
    if status != 201:
        sys.exit("cannot mint a free key: %s %s" % (status, body))
    KEY = body["key"]
    return "freshly minted free key"


def sh(cmd, timeout=30):
    for prefix in ([], ["sudo"]):
        try:
            out = subprocess.run(prefix + cmd, capture_output=True, text=True, timeout=timeout)
            if out.returncode == 0:
                return out.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
    return ""


def memory(label):
    if NO_DOCKER:
        print("  memory[%s]: skipped (KOE_NO_DOCKER=1)" % label)
        return
    rows = [ln.strip() for ln in sh(["docker", "stats", "--no-stream",
                                     "--format", "{{.Name}}={{.MemUsage}}"]).splitlines() if ln.strip()]
    free = sh(["free", "-m"]).splitlines()
    used = ""
    for line in free:
        if line.startswith("Mem:"):
            parts = line.split()
            used = "%s/%s MiB used" % (parts[2], parts[1])
    print("  memory[%s]: %s%s" % (label, "  ".join(rows) or "(docker stats unavailable)",
                                  ("  |  " + used) if used else ""))


def submit(engine, voice, text, sink, index):
    started = time.time()
    status, body = req("POST", "/tts", {"engine": engine, "voice": voice, "text": text})
    sink[index] = (engine, voice, status, body, time.time() - started)


def run_phase(label, jobs, text, interval, peak_sample=False):
    print("\n== %s: %d jobs (%s) ==" % (label, len(jobs), ", ".join(sorted({e for e, _ in jobs}))))
    sink, threads = [None] * len(jobs), []
    t0 = time.time()
    for i, (engine, voice) in enumerate(jobs):
        th = threading.Thread(target=submit, args=(engine, voice, text, sink, i))
        th.start()
        threads.append(th)
    for th in threads:
        th.join()

    accepted, rejected = {}, {}
    for i, item in enumerate(sink):
        engine, voice, status, body, elapsed = item
        if status == 200:
            accepted[body["jobId"]] = (engine, voice, elapsed)
        else:
            rejected[(engine, voice)] = (status, body)

    print("submitted in %.2fs: %d accepted, %d rejected" % (time.time() - t0, len(accepted), len(rejected)))
    for (engine, voice), (status, body) in rejected.items():
        print("  REJECTED %s/%s -> %s %s" % (engine, voice, status, body))
    if not accepted:
        return {"accepted": accepted, "rejected": rejected, "peak": {}, "jobs": {}, "wall": 0, "texts": {}}

    peak_active = peak_queued = 0
    per_engine_peak, first_running, statuses = {}, {}, {}
    global_cap = 0
    deadline = time.time() + 330
    while time.time() < deadline:
        _, health = req("GET", "/healthz", timeout=20)
        queue = health.get("queue", {})
        global_cap = queue.get("concurrency") or global_cap
        active, queued = queue.get("active", 0), queue.get("queued", 0)
        peak_active, peak_queued = max(peak_active, active), max(peak_queued, queued)
        if peak_sample and active >= 3:
            memory("while busy")
            peak_sample = False
        running_by_engine = {}
        done = True
        for job_id, entry in accepted.items():
            engine = entry[0]
            _, job = req("GET", "/job/" + job_id, timeout=20)
            state = job.get("status", "unknown")
            statuses[job_id] = state
            if state not in IDLE:
                running_by_engine[engine] = running_by_engine.get(engine, 0) + 1
                first_running.setdefault(job_id, time.time() - t0)
                done = False
            elif state == "queued":
                done = False
        for engine, count in running_by_engine.items():
            per_engine_peak[engine] = max(per_engine_peak.get(engine, 0), count)
        if done:
            break
        time.sleep(interval)
    wall = time.time() - t0

    print("observed states: %s" % sorted(set(statuses.values())))
    details = {}
    for job_id, entry in accepted.items():
        engine, voice = entry[0], entry[1]
        _, job = req("GET", "/job/" + job_id, timeout=20)
        size = 0
        if job.get("status") == "done":
            r = urllib.request.Request(BASE + "/download/" + job_id, headers={"x-api-key": KEY})
            try:
                raw = urllib.request.urlopen(r, timeout=90).read()
                size = len(raw)
                names = zipfile.ZipFile(io.BytesIO(raw)).namelist()
                assert names, "empty archive"
            except Exception as exc:  # noqa: BLE001 - reported, not swallowed
                print("  download FAILED for %s: %s" % (job_id, exc))
                size = -1
        details[job_id] = {"engine": engine, "voice": voice, "status": job.get("status"),
                           "bytes": size, "wait": round(first_running.get(job_id, -1), 2)}
        print("  %-6s %-18s %-6s waited %5.1fs  %s bytes" %
              (engine, voice, job.get("status"), first_running.get(job_id, -1), size))
    print("peak global active %d/%s, peak queued %d, peak per engine %s, wall %.1fs" %
          (peak_active, global_cap or "?", peak_queued, per_engine_peak or {}, wall))
    memory("after burst")
    return {"accepted": accepted, "rejected": rejected, "peak_active": peak_active,
            "peak_queued": peak_queued, "per_engine_peak": per_engine_peak,
            "global_cap": global_cap, "jobs": details, "wall": wall}


def main():
    print("Koe concurrency test against %s" % BASE)
    print("auth: %s" % resolve_key())
    _, health = req("GET", "/healthz")
    print("healthz: %s" % json.dumps({k: health.get(k) for k in ("ok", "engines", "queue")}))
    for engine in ("edge", "kitten"):
        _, body = req("GET", "/voices?engine=" + engine)
        print("  %-6s voices: %s" % (engine, body.get("count")))
    caps = req("GET", "/api/limits")[1].get("global", {})
    print("engine caps: %s" % caps.get("engines"))
    memory("idle")

    checks = []
    one = run_phase("phase 1 - four mixed jobs", PHASE1, LONG_TEXT, 0.5, peak_sample=True)
    checks.append(("all four submissions accepted", not one["rejected"] and len(one["accepted"]) == 4))
    checks.append(("all four jobs completed",
                   all(j["status"] == "done" for j in one["jobs"].values()) and len(one["jobs"]) == 4))
    checks.append(("all four downloads are non-empty zips",
                   all(j["bytes"] > 0 for j in one["jobs"].values())))
    kitten_peak = one["per_engine_peak"].get("kitten", 0)
    kitten_cap = (caps.get("engines") or {}).get("kitten")
    checks.append(("kitten never ran above its cap (%s)" % kitten_peak,
                   kitten_peak <= (kitten_cap or 1)))
    kitten = [j for j in one["jobs"].values() if j["engine"] == "kitten"]
    serialised = (len(kitten) == 2 and kitten[0]["wait"] >= 0 and kitten[1]["wait"] >= 0 and
                  round(abs(kitten[0]["wait"] - kitten[1]["wait"]), 1) > 1.0)
    checks.append(("the two kitten jobs did not start together (cap serialises them)", serialised))

    if "--no-oversubscribe" not in sys.argv:
        two = run_phase("phase 2 - oversubscribe six jobs", PHASE2, SHORT_TEXT, 0.4, peak_sample=True)
        cap = two["global_cap"] or one["global_cap"]
        checks.append(("global active never exceeded %s (%d)" % (cap, two["peak_active"]),
                       bool(cap) and two["peak_active"] <= cap))
        checks.append(("surplus jobs queued instead of overflowing (%d queued)" % two["peak_queued"],
                       two["peak_queued"] >= 1))
        checks.append(("every oversubscribed job still finished",
                       all(j["status"] == "done" for j in two["jobs"].values())))

    _, final = req("GET", "/healthz")
    idle = final.get("queue", {}).get("active") == 0 and final.get("queue", {}).get("queued") == 0
    checks.append(("queue drained back to zero", idle))
    memory("final")

    print("\n== verdict ==")
    for name, ok in checks:
        print("  %s  %s" % ("PASS" if ok else "FAIL", name))
    failed = [n for n, ok in checks if not ok]
    print("\n%d/%d checks passed%s" % (len(checks) - len(failed), len(checks),
                                       "" if not failed else " - FAILED: " + "; ".join(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
