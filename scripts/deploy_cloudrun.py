"""Deploy Quote Room to Google Cloud Run as ONE always-on instance.

Usage: python scripts/deploy_cloudrun.py <gcp-project-id> [region]

- Secrets come from the local .env and go to Cloud Run as environment variables through a temp
  file outside the repo that is deleted afterwards. Values are never printed.
- min=max=1 instance with CPU always allocated: the Slack Socket Mode connection, the room state
  and agent turns all run between HTTP requests, so the instance must never scale to zero or be
  throttled, and there must never be two (Slack would split button taps between them).
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
GCLOUD = shutil.which("gcloud.cmd") or shutil.which("gcloud") or "gcloud"
SERVICE = "quote-room"
SKIP = {"PORT", "PUBLIC_URL"}  # PORT is reserved on Cloud Run; PUBLIC_URL (an old tunnel) is unused


def run(args, capture=False):
    print("> gcloud " + " ".join(a if not a.endswith(".yaml") else "<env-file>" for a in args))
    r = subprocess.run([GCLOUD, *args], text=True, capture_output=capture)
    if r.returncode != 0:
        if capture:
            sys.stderr.write(r.stderr[-2000:])
        sys.exit(f"gcloud failed ({r.returncode})")
    return (r.stdout or "").strip()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    project, region = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "us-west1")
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"')
            if k and v and k not in SKIP:
                env[k] = v
    print(f"env vars: {len(env)} keys ({', '.join(sorted(env))})")

    fd, tmp = tempfile.mkstemp(suffix=".yaml")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for k, v in env.items():
                f.write(f"{k}: {json.dumps(v)}\n")
        run(["services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "--project", project])
        run(["run", "deploy", SERVICE, "--source", str(ROOT), "--project", project, "--region", region,
             "--allow-unauthenticated", "--min-instances", "1", "--max-instances", "1", "--no-cpu-throttling",
             "--cpu", "1", "--memory", "1Gi", "--timeout", "3600", "--concurrency", "80",
             "--env-vars-file", tmp, "--quiet"])
    finally:
        os.remove(tmp)
    url = run(["run", "services", "describe", SERVICE, "--project", project, "--region", region, "--format", "value(status.url)"], capture=True)
    print(f"\nLIVE: {url}\nRoom (projector): {url}/room\nAdmin: {url}/admin")


if __name__ == "__main__":
    main()
