"""
Task: run_banner_grab
Payload:
  targets: list of {host, port} dicts e.g. [{"host":"192.168.1.1","port":22}]
  timeout: seconds per connection (default: 5)
  send_probe: optional string to send before reading banner

Connects to each host:port and reads the service banner.
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')


async def run(payload: dict) -> dict:
    targets = payload.get("targets", [])
    timeout = float(payload.get("timeout", 5))
    probe   = payload.get("send_probe", None)

    if not targets:
        raise ValueError("No targets provided")

    results = []
    for t in targets[:20]:  # cap at 20
        if not isinstance(t, dict):
            results.append({"error": f"Invalid target: {t!r}"})
            continue
        host = str(t.get("host", ""))
        port = int(t.get("port", 80))

        if not SAFE_HOST_RE.match(host):
            results.append({"host": host, "port": port, "error": "Invalid host"})
            continue

        result = await _grab_banner(host, port, timeout, probe)
        results.append(result)

    return {
        "results":       results,
        "targets_tried": len(results),
        "banners_found": sum(1 for r in results if r.get("banner")),
    }


async def _grab_banner(host: str, port: int, timeout: float, probe: str = None) -> dict:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout,
        )

        # Send probe if specified
        if probe:
            writer.write((probe + "\r\n").encode())
            await writer.drain()

        # Read up to 1KB of banner
        try:
            data = await asyncio.wait_for(reader.read(1024), timeout=timeout)
            banner = data.decode("utf-8", errors="replace").strip()
        except asyncio.TimeoutError:
            banner = ""

        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass

        # Try to identify service from banner
        service = _identify_service(port, banner)

        return {
            "host":    host,
            "port":    port,
            "open":    True,
            "banner":  banner[:500] if banner else None,
            "service": service,
        }

    except asyncio.TimeoutError:
        return {"host": host, "port": port, "open": False, "error": "timeout"}
    except ConnectionRefusedError:
        return {"host": host, "port": port, "open": False, "error": "connection refused"}
    except Exception as e:
        return {"host": host, "port": port, "open": False, "error": str(e)[:100]}


def _identify_service(port: int, banner: str) -> str:
    banner_lower = banner.lower()
    if "ssh" in banner_lower:
        return "SSH"
    if "ftp" in banner_lower or "filezilla" in banner_lower:
        return "FTP"
    if "smtp" in banner_lower or "220 " in banner[:10]:
        return "SMTP"
    if "http" in banner_lower:
        return "HTTP"
    if "pop3" in banner_lower:
        return "POP3"
    if "imap" in banner_lower:
        return "IMAP"
    if "mysql" in banner_lower:
        return "MySQL"
    if "rdp" in banner_lower or port == 3389:
        return "RDP"
    # Fall back to well-known port
    PORT_SERVICES = {
        21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS",
        80: "HTTP", 110: "POP3", 143: "IMAP", 443: "HTTPS", 445: "SMB",
        3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 6379: "Redis",
        8080: "HTTP-Alt", 8443: "HTTPS-Alt",
    }
    return PORT_SERVICES.get(port, "Unknown")
