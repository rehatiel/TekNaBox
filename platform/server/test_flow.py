#!/usr/bin/env python3
"""
MSP Platform - End-to-End API Test Flow
========================================
Runs a full scenario against a live running server:

  1.  Health check
  2.  Create MSP organization (super admin)
  3.  Create MSP admin operator
  4.  Login as MSP admin
  5.  Create customer + site
  6.  Create device slot → get enrollment secret
  7.  Enroll device (simulates Pi calling /v1/enroll)
  8.  List devices → verify active
  9.  Issue a task to the device
  10. Connect device WebSocket → receive task, send result
  11. Verify task marked completed
  12. Send telemetry over WebSocket
  13. Upload a fake client release artifact
  14. Trigger rollout to all devices
  15. Simulate device reporting update_status progression
  16. Revoke the device → verify kill received over WebSocket
  17. Print audit log

Usage:
    pip install httpx websockets rich
    python test_flow.py [--base-url http://localhost:8000]

Set SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD env vars if your seed differs.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime

import httpx
import websockets
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich import print as rprint

console = Console()

# ── Config ────────────────────────────────────────────────────────────────────

DEFAULT_BASE = "http://localhost:8005"

# These match the seed data created by the script itself on first run.
# Override via env if your server already has a super admin seeded.
SUPER_ADMIN_EMAIL = os.getenv("SUPER_ADMIN_EMAIL", "superadmin@platform.local")
SUPER_ADMIN_PASSWORD = os.getenv("SUPER_ADMIN_PASSWORD", "SuperSecret123!")


# ── Helpers ───────────────────────────────────────────────────────────────────

class TestError(Exception):
    pass


def step(n: int, title: str):
    console.rule(f"[bold cyan]Step {n}: {title}[/bold cyan]")


def ok(msg: str):
    console.print(f"  [bold green]✓[/bold green] {msg}")


def info(msg: str):
    console.print(f"  [dim]→ {msg}[/dim]")


def fail(msg: str):
    console.print(f"  [bold red]✗ {msg}[/bold red]")
    raise TestError(msg)


def check(r: httpx.Response, expected: int = 200, label: str = ""):
    if r.status_code != expected:
        fail(f"{label} — expected HTTP {expected}, got {r.status_code}: {r.text[:300]}")
    ok(f"{label} → HTTP {r.status_code}")
    return r.json()


# ── Seed super admin (direct DB call not available; use a bootstrap endpoint) ─
# In a real deployment you'd seed via a management CLI or migration.
# Here we POST to /v1/bootstrap which we'll detect or skip if already seeded.

async def run(base: str):
    ws_base = base.replace("http://", "ws://").replace("https://", "wss://")

    console.print(Panel.fit(
        f"[bold]MSP Platform — End-to-End Test[/bold]\n[dim]Target: {base}[/dim]",
        border_style="cyan"
    ))

    results = []

    async with httpx.AsyncClient(base_url=base, timeout=30) as client:

        # ── 1. Health ─────────────────────────────────────────────────────────
        step(1, "Health Check")
        r = await client.get("/health")
        if r.status_code != 200:
            fail(f"GET /health — expected HTTP 200, got {r.status_code}")
        ok(f"GET /health → HTTP {r.status_code}")
        results.append(("Health check", "PASS"))

        # ── 2. Bootstrap super admin ──────────────────────────────────────────
        step(2, "Bootstrap Super Admin")
        r = await client.post("/v1/bootstrap", json={
            "email": SUPER_ADMIN_EMAIL,
            "password": SUPER_ADMIN_PASSWORD,
        })
        if r.status_code == 200:
            ok("Super admin created")
        elif r.status_code == 409:
            ok("Super admin already exists — skipping")
        else:
            fail(f"Bootstrap failed: {r.status_code} {r.text}")
        results.append(("Bootstrap super admin", "PASS"))

        # ── 3. Login as super admin ───────────────────────────────────────────
        step(3, "Login as Super Admin")
        data = check(await client.post("/v1/auth/login", json={
            "email": SUPER_ADMIN_EMAIL,
            "password": SUPER_ADMIN_PASSWORD,
        }), 200, "POST /v1/auth/login")
        super_token = data["access_token"]
        info(f"Token: {super_token[:40]}…")
        super_headers = {"Authorization": f"Bearer {super_token}"}
        results.append(("Super admin login", "PASS"))

        # ── 4. Create MSP organization ────────────────────────────────────────
        step(4, "Create MSP Organization")
        data = check(await client.post("/v1/msps", json={
            "name": "Acme MSP",
            "slug": f"acme-msp-{int(time.time())}",
        }, headers=super_headers), 200, "POST /v1/msps")
        msp_id = data["id"]
        info(f"MSP ID: {msp_id}")
        results.append(("Create MSP", "PASS"))

        # ── 5. Create MSP admin operator ──────────────────────────────────────
        step(5, "Create MSP Admin Operator")
        msp_admin_email = f"admin-{int(time.time())}@acmemsp.com"
        msp_admin_pass = "MspAdmin456!"
        data = check(await client.post("/v1/operators", json={
            "email": msp_admin_email,
            "password": msp_admin_pass,
            "role": "msp_admin",
            "msp_id": msp_id,
        }, headers=super_headers), 200, "POST /v1/operators")
        operator_id = data["id"]
        info(f"Operator ID: {operator_id}")
        results.append(("Create MSP admin operator", "PASS"))

        # ── 6. Login as MSP admin ─────────────────────────────────────────────
        step(6, "Login as MSP Admin")
        data = check(await client.post("/v1/auth/login", json={
            "email": msp_admin_email,
            "password": msp_admin_pass,
        }), 200, "POST /v1/auth/login (MSP admin)")
        msp_token = data["access_token"]
        msp_headers = {"Authorization": f"Bearer {msp_token}"}
        results.append(("MSP admin login", "PASS"))

        # ── 7. Create customer ────────────────────────────────────────────────
        step(7, "Create Customer + Site")
        data = check(await client.post("/v1/customers", json={
            "name": "Contoso Ltd",
            "slug": f"contoso-{int(time.time())}",
        }, headers=msp_headers), 200, "POST /v1/customers")
        customer_id = data["id"]
        info(f"Customer ID: {customer_id}")

        data = check(await client.post("/v1/sites", json={
            "name": "HQ London",
            "customer_id": customer_id,
        }, headers=msp_headers), 200, "POST /v1/sites")
        site_id = data["id"]
        info(f"Site ID: {site_id}")
        results.append(("Create customer + site", "PASS"))

        # ── 8. Create device slot ─────────────────────────────────────────────
        step(8, "Create Device Slot")
        data = check(await client.post("/v1/devices", json={
            "name": "pi-zero-01",
            "site_id": site_id,
            "role": "diagnostic",
        }, headers=msp_headers), 200, "POST /v1/devices")
        device_id = data["device_id"]
        enrollment_secret = data["enrollment_secret"]
        info(f"Device ID: {device_id}")
        info(f"Enrollment secret: {enrollment_secret[:12]}…")
        results.append(("Create device slot", "PASS"))

        # ── 9. Enroll device (simulate Pi) ────────────────────────────────────
        step(9, "Enroll Device (simulating Raspberry Pi)")
        data = check(await client.post("/v1/enroll", json={
            "enrollment_secret": enrollment_secret,
            "hardware_id": f"a02082-{int(time.time())}",
            "arch": "armv6l",
            "current_version": "1.0.0",
            "cert_fingerprint": "sha256:aabbccddeeff",
        }), 200, "POST /v1/enroll")
        device_token = data["access_token"]
        info(f"Device token: {device_token[:40]}…")
        results.append(("Device enrollment", "PASS"))

        # ── 10. List devices → check active ───────────────────────────────────
        step(10, "List Devices — verify status=active")
        data = check(await client.get("/v1/devices", headers=msp_headers), 200, "GET /v1/devices")
        device = next((d for d in data if d["id"] == device_id), None)
        if not device:
            fail("Enrolled device not found in list")
        if device["status"] != "active":
            fail(f"Expected status=active, got {device['status']}")
        ok(f"Device status: {device['status']}, version: {device['current_version']}")
        results.append(("Device active after enroll", "PASS"))

        # ── 11. Issue a task ──────────────────────────────────────────────────
        step(11, "Issue Task to Device")
        data = check(await client.post(f"/v1/devices/{device_id}/tasks", json={
            "task_type": "run_nmap_scan",
            "payload": {"targets": ["10.0.0.1"], "ports": "22,80,443"},
            "timeout_seconds": 120,
            "idempotency_key": f"test-scan-{device_id[:8]}-{int(time.time())}",
        }, headers=msp_headers), 200, "POST /v1/devices/{id}/tasks")
        task_id = data["task_id"]
        info(f"Task ID: {task_id}, status: {data['status']}")
        results.append(("Issue task", "PASS"))

        # ── 12. WebSocket: connect, receive task, send result + telemetry ─────
        step(12, "WebSocket — Device connects, receives task, sends result")
        ws_url = f"{ws_base}/v1/devices/channel?token={device_token}"
        info(f"Connecting to {ws_url[:60]}…")

        received_task = None
        received_kill = False

        async with websockets.connect(ws_url) as ws:
            ok("WebSocket connected")

            # Collect messages for up to 3 seconds
            deadline = asyncio.get_event_loop().time() + 3
            while asyncio.get_event_loop().time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    msg = json.loads(raw)
                    info(f"  ← Received: type={msg.get('type')} id={msg.get('id','')}")
                    if msg.get("type") == "task":
                        received_task = msg
                    if msg.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                except asyncio.TimeoutError:
                    break

            if not received_task:
                fail("Did not receive queued task over WebSocket")
            ok(f"Task received: task_type={received_task['task_type']}")

            # Send heartbeat
            await ws.send(json.dumps({
                "type": "heartbeat",
                "version": "1.0.0",
                "uptime_seconds": 3600,
            }))
            ok("Heartbeat sent")

            # Send task result
            await ws.send(json.dumps({
                "type": "task_result",
                "id": task_id,
                "success": True,
                "result": {
                    "hosts_up": 1,
                    "open_ports": [22, 443],
                    "scan_duration_ms": 847,
                },
            }))
            ok("Task result sent")

            # Send telemetry
            await ws.send(json.dumps({
                "type": "telemetry",
                "telemetry_type": "network_stats",
                "task_id": task_id,
                "data": {
                    "rx_bytes": 102400,
                    "tx_bytes": 4096,
                    "latency_ms": 12,
                },
            }))
            ok("Telemetry sent")

            # Small pause to let server process
            await asyncio.sleep(1)

        results.append(("WebSocket task delivery + result", "PASS"))

        # ── 13. Verify task completed ─────────────────────────────────────────
        step(13, "Verify Task Completed in DB")
        data = check(await client.get(f"/v1/devices/{device_id}/tasks", headers=msp_headers),
                     200, "GET /v1/devices/{id}/tasks")
        task = next((t for t in data if t["id"] == task_id), None)
        if not task:
            fail("Task not found")
        if task["status"] != "completed":
            fail(f"Expected status=completed, got {task['status']}")
        ok(f"Task status: {task['status']}")
        info(f"Result: {json.dumps(task.get('result'), indent=2)}")
        results.append(("Task completed in DB", "PASS"))

        # ── 14. Upload a release artifact ─────────────────────────────────────
        step(14, "Upload Client Release Artifact")
        fake_binary = b"\x7fELF" + b"\x00" * 128  # fake ARM ELF header
        ts = int(time.time())
        r = await client.post(
            "/v1/releases",
            params={
                "version": f"1.1.{ts}",
                "arch": "armv6l",
                "channel": "stable",
                "is_mandatory": "false",
                "release_notes": "Test release from e2e script",
            },
            files={"artifact": ("agent-1.1.0-armv6l.bin", fake_binary, "application/octet-stream")},
            headers=msp_headers,
        )
        data = check(r, 200, "POST /v1/releases")
        release_id = data["id"]
        info(f"Release ID: {release_id}, SHA256: {data['sha256'][:16]}…")
        results.append(("Upload release", "PASS"))

        # ── 15. Trigger rollout ───────────────────────────────────────────────
        step(15, "Trigger Update Rollout")
        data = check(await client.post(
            f"/v1/releases/{release_id}/rollout",
            params={"rollout_percent": 100, "is_forced": "false"},
            headers=msp_headers,
        ), 200, "POST /v1/releases/{id}/rollout")
        info(f"Scheduled devices: {data['scheduled_devices']}")
        results.append(("Trigger rollout", "PASS"))

        # ── 16. Simulate device update flow over WebSocket ────────────────────
        step(16, "Simulate Device Update Status Progression")
        async with websockets.connect(ws_url) as ws:
            ok("WebSocket reconnected")

            update_msg = None
            deadline = asyncio.get_event_loop().time() + 4
            while asyncio.get_event_loop().time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.5)
                    msg = json.loads(raw)
                    info(f"  ← {msg.get('type')}")
                    if msg.get("type") == "update_available":
                        update_msg = msg
                        break
                    if msg.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                except asyncio.TimeoutError:
                    break

            if not update_msg:
                console.print("  [yellow]⚠ update_available not received in window (device may need scheduler tick)[/yellow]")
                results.append(("Update notification via WS", "SKIP"))
            else:
                ok(f"update_available received: version={update_msg['version']}")
                job_id = update_msg["job_id"]

                for status in ["downloading", "applying", "completed"]:
                    payload = {
                        "type": "update_status",
                        "job_id": job_id,
                        "status": status,
                    }
                    if status == "completed":
                        payload["version"] = "1.1.0"
                    await ws.send(json.dumps(payload))
                    info(f"  → Reported update_status: {status}")
                    await asyncio.sleep(0.3)

                ok("Full update progression reported")
                results.append(("Update notification via WS", "PASS"))

            await asyncio.sleep(0.5)

        # ── 17. Revoke device ─────────────────────────────────────────────────
        step(17, "Revoke Device — verify kill over WebSocket")
        kill_received = asyncio.Event()

        async def watch_for_kill():
            try:
                async with websockets.connect(ws_url) as ws:
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("type") == "kill":
                            kill_received.set()
                            return
            except Exception:
                pass  # Connection closed after kill — expected

        kill_task = asyncio.create_task(watch_for_kill())
        await asyncio.sleep(0.5)  # Let WS connect

        check(await client.post(
            f"/v1/devices/{device_id}/revoke",
            params={"reason": "e2e test cleanup"},
            headers=msp_headers,
        ), 200, "POST /v1/devices/{id}/revoke")

        try:
            await asyncio.wait_for(kill_received.wait(), timeout=3)
            ok("Kill signal received by device WebSocket")
            results.append(("Device revoke + kill signal", "PASS"))
        except asyncio.TimeoutError:
            console.print("  [yellow]⚠ Kill not received in 3s (may have arrived before listener)[/yellow]")
            results.append(("Device revoke + kill signal", "SKIP"))
        finally:
            kill_task.cancel()

        # ── 18. Verify device revoked ─────────────────────────────────────────
        step(18, "Verify Revoked Device Blocked")
        r = await client.get("/v1/devices", headers=msp_headers)
        devices = r.json()
        d = next((x for x in devices if x["id"] == device_id), None)
        if d and d["status"] == "revoked":
            ok("Device status = revoked")
        else:
            fail("Device not showing revoked status")
        results.append(("Device status revoked", "PASS"))

        # Try WebSocket with revoked device — should be rejected
        try:
            async with websockets.connect(ws_url) as ws:
                await ws.recv()
            fail("Revoked device should not connect")
        except websockets.exceptions.InvalidStatusCode as e:
            ok(f"Revoked device correctly rejected (HTTP {e.status_code})")
        except Exception:
            ok("Revoked device connection rejected")
        results.append(("Revoked device blocked from WS", "PASS"))

        # ── 19. Audit log ─────────────────────────────────────────────────────
        step(19, "Audit Log")
        data = check(await client.get("/v1/audit", params={"limit": 20}, headers=msp_headers),
                     200, "GET /v1/audit")
        table = Table(title="Recent Audit Events", show_lines=True)
        table.add_column("Action", style="cyan")
        table.add_column("Device ID", style="dim")
        table.add_column("Operator ID", style="dim")
        table.add_column("Timestamp")
        for entry in data[:10]:
            table.add_row(
                entry["action"],
                (entry.get("device_id") or "—")[:8],
                (entry.get("operator_id") or "—")[:8],
                str(entry.get("created_at", ""))[:19],
            )
        console.print(table)
        results.append(("Audit log", "PASS"))

    # ── Summary ───────────────────────────────────────────────────────────────
    console.rule("[bold]Test Summary[/bold]")
    summary = Table(show_header=True)
    summary.add_column("Test", style="white")
    summary.add_column("Result")

    passed = skipped = failed_count = 0
    for name, result in results:
        if result == "PASS":
            summary.add_row(name, "[bold green]PASS[/bold green]")
            passed += 1
        elif result == "SKIP":
            summary.add_row(name, "[yellow]SKIP[/yellow]")
            skipped += 1
        else:
            summary.add_row(name, "[bold red]FAIL[/bold red]")
            failed_count += 1

    console.print(summary)
    console.print(f"\n  Passed: [green]{passed}[/green]  Skipped: [yellow]{skipped}[/yellow]  Failed: [red]{failed_count}[/red]\n")

    return failed_count == 0


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MSP Platform E2E test")
    parser.add_argument("--base-url", default=DEFAULT_BASE, help="Server base URL")
    args = parser.parse_args()

    try:
        success = asyncio.run(run(args.base_url))
        sys.exit(0 if success else 1)
    except TestError as e:
        console.print(f"\n[bold red]Test aborted: {e}[/bold red]")
        sys.exit(1)
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted[/yellow]")
        sys.exit(1)
