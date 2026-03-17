#!/bin/bash
# =============================================================================
# MSP Agent Installer
# Supports: Raspberry Pi OS, Debian, Ubuntu (amd64 / arm64 / armv7 / armv6)
# =============================================================================
# Usage:
#   sudo bash install.sh \
#     --server https://yourserver.com \
#     --secret <enrollment_secret>
#
# Optional:
#   --version 1.0.0         (default: 1.0.0)
#   --log-level DEBUG       (default: INFO)
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────
SERVER_URL=""
ENROLLMENT_SECRET=""
VERSION="1.0.0"
LOG_LEVEL="INFO"

while [[ $# -gt 0 ]]; do
    case $1 in
        --server)    SERVER_URL="$2"; shift 2 ;;
        --secret)    ENROLLMENT_SECRET="$2"; shift 2 ;;
        --version)   VERSION="$2"; shift 2 ;;
        --log-level) LOG_LEVEL="$2"; shift 2 ;;
        *) error "Unknown argument: $1" ;;
    esac
done

[[ -z "$SERVER_URL" ]]        && error "--server is required (e.g. https://yourserver.com)"
[[ -z "$ENROLLMENT_SECRET" ]] && error "--secret is required (get this from the MSP portal)"
[[ $EUID -ne 0 ]]             && error "This script must be run as root (use sudo)"

# Derive API base and WebSocket URL
API_BASE="${SERVER_URL}"
WS_URL=$(echo "$SERVER_URL" | sed 's/^http/ws/')

info "======================================================"
info " MSP Agent Installer"
info " Server:  $SERVER_URL"
info " Version: $VERSION"
info "======================================================"

# ── Hardware detection ────────────────────────────────────────────────────────
# Identify Pi model from device tree (most reliable across all Pi hardware)
PI_MODEL=""
PI_MEMTOTAL_MB=0
IS_PI=false

if [ -f /proc/device-tree/model ]; then
    PI_MODEL=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo "")
elif [ -f /sys/firmware/devicetree/base/model ]; then
    PI_MODEL=$(tr -d '\0' < /sys/firmware/devicetree/base/model 2>/dev/null || echo "")
fi

# Also accept BCM283x / BCM271x in /proc/cpuinfo as a fallback signal
if [ -z "$PI_MODEL" ]; then
    hw=$(grep -m1 "^Hardware" /proc/cpuinfo 2>/dev/null | awk '{print $3}' || echo "")
    case "$hw" in BCM28*|BCM271*) PI_MODEL="Raspberry Pi (unknown model)" ;; esac
fi

if [ -n "$PI_MODEL" ]; then
    IS_PI=true
    info "Detected Pi hardware: $PI_MODEL"
else
    ARCH=$(uname -m)
    info "Non-Pi hardware detected (arch: $ARCH)"
fi

# Read total RAM — used to set a sensible MemoryMax in the service file
PI_MEMTOTAL_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)

# Derive a safe MemoryMax: half of total RAM, floored at 128M, capped at 512M for Pi,
# and uncapped (empty = no limit) for servers with >2GB
SERVICE_MEMORY_MAX=""
if $IS_PI; then
    _half=$(( PI_MEMTOTAL_MB / 2 ))
    _cap=$(( _half < 128 ? 128 : _half ))
    _cap=$(( _cap > 512 ? 512 : _cap ))
    SERVICE_MEMORY_MAX="${_cap}M"
    info "  RAM: ${PI_MEMTOTAL_MB}MB — setting MemoryMax=${SERVICE_MEMORY_MAX} in service"
elif (( PI_MEMTOTAL_MB > 0 && PI_MEMTOTAL_MB <= 2048 )); then
    # Low-RAM non-Pi device (cheap VPS, embedded server) — still cap it
    SERVICE_MEMORY_MAX="$(( PI_MEMTOTAL_MB / 2 ))M"
    info "  RAM: ${PI_MEMTOTAL_MB}MB — setting MemoryMax=${SERVICE_MEMORY_MAX} in service"
else
    info "  RAM: ${PI_MEMTOTAL_MB}MB — no MemoryMax applied"
fi

# ── APT repositories — enable contrib and non-free ───────────────────────────
info "Checking apt repositories..."

# Detect codename (bookworm, bullseye, buster, etc.)
CODENAME=""
if [ -f /etc/os-release ]; then
    CODENAME=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
fi
if [ -z "$CODENAME" ] && command -v lsb_release &>/dev/null; then
    CODENAME=$(lsb_release -sc 2>/dev/null || echo "")
fi
CODENAME="${CODENAME:-bookworm}"

_ensure_non_free() {
    local file="$1"
    [ -f "$file" ] || return 1

    # Skip comment lines; check if any active deb line already has non-free
    if grep -qE '^deb[^#]*(non-free|contrib)' "$file" 2>/dev/null; then
        return 0  # already present
    fi

    # Add contrib non-free (+ non-free-firmware for Bookworm+) to the first
    # active 'deb' line that references the OS main archive
    if grep -qE '^deb ' "$file" 2>/dev/null; then
        local extras="contrib non-free"
        # Bookworm (Debian 12) split firmware into a separate non-free-firmware component
        case "$CODENAME" in bookworm|trixie|forky) extras="contrib non-free non-free-firmware" ;; esac

        # Append extras to any 'main'-only deb lines (leaves lines already having extras alone)
        sed -i "s|^\(deb[^#]*\) main\s*$|\1 main $extras|" "$file"
        info "  Enabled $extras in $file"
        return 0
    fi
    return 1
}

SOURCES_UPDATED=false

# 1. Classic /etc/apt/sources.list
if _ensure_non_free /etc/apt/sources.list; then
    SOURCES_UPDATED=true
fi

# 2. Drop-in .list files (Raspberry Pi OS often uses these)
for f in /etc/apt/sources.list.d/*.list; do
    [ -f "$f" ] || continue
    _ensure_non_free "$f" && SOURCES_UPDATED=true
done

# 3. DEB822 .sources files (newer Debian/Ubuntu systems)
for f in /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    if grep -qE '^Components:' "$f" 2>/dev/null; then
        if ! grep -qE 'non-free' "$f" 2>/dev/null; then
            deb822_extras="contrib non-free"
            case "$CODENAME" in bookworm|trixie|forky) deb822_extras="contrib non-free non-free-firmware" ;; esac
            sed -i "s|^Components: main\s*$|Components: main $deb822_extras|" "$f"
            info "  Enabled $deb822_extras in $f"
            SOURCES_UPDATED=true
        fi
    fi
done

if $SOURCES_UPDATED; then
    info "Refreshing package lists after enabling non-free repos..."
    apt-get update -qq
else
    info "non-free/contrib repos already enabled — no changes needed"
fi

# ── System dependencies ───────────────────────────────────────────────────────
info "Installing system dependencies..."
apt-get update -qq

# Core
apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl ca-certificates \
    2>/dev/null

# Network tools
info "Installing network tools..."
apt-get install -y --no-install-recommends \
    nmap \
    iputils-ping \
    iproute2 \
    traceroute \
    mtr \
    iperf3 \
    arp-scan \
    wireless-tools \
    iw \
    dnsutils \
    netcat-openbsd \
    2>/dev/null || warn "Some network tools failed to install"

# Packet analysis + live bandwidth monitoring
info "Installing packet analysis tools..."
apt-get install -y --no-install-recommends \
    tshark \
    tcpdump \
    tcptrack \
    nethogs \
    iftop \
    2>/dev/null || warn "Some packet tools failed to install"

# SNMP — core tools (snmpwalk, snmpget) are in the 'snmp' package
info "Installing SNMP tools..."
apt-get install -y --no-install-recommends snmp \
    2>/dev/null || warn "snmp package failed to install"

# snmp-mibs-downloader requires non-free repos — best-effort only
apt-get install -y --no-install-recommends snmp-mibs-downloader \
    2>/dev/null || true   # silent — not available on all distros

# AD / Windows enumeration
info "Installing AD enumeration tools..."
apt-get install -y --no-install-recommends \
    smbclient \
    ldap-utils \
    2>/dev/null || warn "Some AD tools failed to install (optional)"

# rpcclient lives in samba-common-bin on Debian/Ubuntu
apt-get install -y --no-install-recommends \
    samba-common-bin \
    2>/dev/null || warn "rpcclient not available (optional)"

# ── Python dependencies ───────────────────────────────────────────────────────
info "Installing Python dependencies from requirements.txt..."

SCRIPT_DIR_EARLY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQS_FILE="$SCRIPT_DIR_EARLY/requirements.txt"

if [[ -f "$REQS_FILE" ]]; then
    # Try --break-system-packages first (Python 3.11+ / Debian 12+), fall back
    pip3 install --quiet --break-system-packages -r "$REQS_FILE" 2>/dev/null || \
    pip3 install --quiet -r "$REQS_FILE" 2>/dev/null || \
        error "Failed to install Python packages from requirements.txt"
    info "Python packages installed from requirements.txt"
else
    warn "requirements.txt not found — installing core packages manually"
    pip3 install --quiet --break-system-packages websockets 2>/dev/null || \
    pip3 install --quiet websockets 2>/dev/null || \
        error "Failed to install websockets"

    pip3 install --quiet --break-system-packages speedtest-cli impacket 2>/dev/null || \
    pip3 install --quiet speedtest-cli impacket 2>/dev/null || \
        warn "Optional packages (speedtest-cli, impacket) install failed"
fi

# Enable SNMP MIBs (Debian/Ubuntu disables them by default)
if [ -f /etc/snmp/snmp.conf ]; then
    sed -i 's/^mibs :#/mibs :/' /etc/snmp/snmp.conf 2>/dev/null || true
fi

# Allow tshark to capture without root (adds msp-agent to wireshark group)
if getent group wireshark > /dev/null 2>&1; then
    usermod -aG wireshark msp-agent 2>/dev/null || true
fi

# ── Create user ───────────────────────────────────────────────────────────────
info "Creating msp-agent system user..."
if ! id -u msp-agent &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin msp-agent
fi

# ── Directory structure ───────────────────────────────────────────────────────
info "Creating directories..."
mkdir -p /etc/msp-agent
mkdir -p /var/log/msp-agent
mkdir -p /opt/msp-agent

chown root:msp-agent /etc/msp-agent
chmod 770 /etc/msp-agent          # group-writable so agent can save config.json.tmp

chown msp-agent:msp-agent /var/log/msp-agent
chmod 755 /var/log/msp-agent

chown msp-agent:msp-agent /opt/msp-agent
chmod 755 /opt/msp-agent

# ── Get hardware ID ───────────────────────────────────────────────────────────
# Prefer Pi CPU serial; fall back to hostname + MAC of first active non-loopback interface
HARDWARE_ID=$(grep -m1 "^Serial" /proc/cpuinfo 2>/dev/null | awk '{print $3}' || echo "")
if [[ -z "$HARDWARE_ID" || "$HARDWARE_ID" == "0000000000000000" ]]; then
    BEST_MAC=""
    for iface in $(ls /sys/class/net/ 2>/dev/null | grep -v lo); do
        mac=$(cat "/sys/class/net/$iface/address" 2>/dev/null || echo "")
        state=$(cat "/sys/class/net/$iface/operstate" 2>/dev/null || echo "")
        if [[ -n "$mac" && "$mac" != "00:00:00:00:00:00" ]]; then
            BEST_MAC="$mac"
            [[ "$state" == "up" ]] && break   # prefer an active interface
        fi
    done
    HARDWARE_ID=$(hostname)-${BEST_MAC:-unknown}
fi
info "Hardware ID: $HARDWARE_ID"

# ── Write config ──────────────────────────────────────────────────────────────
info "Writing configuration..."
cat > /etc/msp-agent/config.json << EOF
{
  "server_url": "$WS_URL",
  "api_base": "$API_BASE",
  "device_id": null,
  "access_token": null,
  "enrollment_secret": "$ENROLLMENT_SECRET",
  "version": "$VERSION",
  "hardware_id": "$HARDWARE_ID",
  "pi_model": "$PI_MODEL",
  "heartbeat_interval": 30,
  "reconnect_min": 5,
  "reconnect_max": 300,
  "log_level": "$LOG_LEVEL",
  "log_file": "/var/log/msp-agent/agent.log"
}
EOF

chown root:msp-agent /etc/msp-agent/config.json
chmod 660 /etc/msp-agent/config.json  # group-writable so agent can update tokens

# ── Stop existing service ─────────────────────────────────────────────────────
if systemctl is-active --quiet msp-agent 2>/dev/null; then
    info "Stopping existing msp-agent service..."
    systemctl stop msp-agent
    # Wait up to 10 s for the process to exit cleanly
    for _i in $(seq 1 10); do
        systemctl is-active --quiet msp-agent 2>/dev/null || break
        sleep 1
    done
    if systemctl is-active --quiet msp-agent 2>/dev/null; then
        warn "Service did not stop cleanly — sending SIGKILL"
        systemctl kill --signal=SIGKILL msp-agent 2>/dev/null || true
        sleep 1
    fi
    info "Previous service stopped ✓"
elif systemctl list-units --all --no-pager 2>/dev/null | grep -q 'msp-agent.service'; then
    info "msp-agent service present but not running — continuing"
fi

# ── Install agent files ───────────────────────────────────────────────────────
info "Installing agent files..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp "$SCRIPT_DIR/agent.py" /opt/msp-agent/agent.py

# Remove and replace — prevents stale files from old installs persisting
rm -rf /opt/msp-agent/core  && cp -r "$SCRIPT_DIR/core"  /opt/msp-agent/core
rm -rf /opt/msp-agent/tasks && cp -r "$SCRIPT_DIR/tasks" /opt/msp-agent/tasks

chown -R msp-agent:msp-agent /opt/msp-agent
chmod -R 755 /opt/msp-agent

# ── Create launcher binary ────────────────────────────────────────────────────
info "Creating launcher..."
cat > /usr/local/bin/msp-agent << 'LAUNCHER'
#!/bin/bash
exec python3 /opt/msp-agent/agent.py "$@"
LAUNCHER

chmod +x /usr/local/bin/msp-agent

# ── Install systemd service ───────────────────────────────────────────────────
info "Installing systemd service..."
cp "$SCRIPT_DIR/msp-agent.service" /etc/systemd/system/msp-agent.service

# Patch MemoryMax based on detected hardware RAM
if [[ -n "$SERVICE_MEMORY_MAX" ]]; then
    sed -i "s|^MemoryMax=.*|MemoryMax=${SERVICE_MEMORY_MAX}|" \
        /etc/systemd/system/msp-agent.service
else
    # No limit — comment out the line rather than leaving a stale value
    sed -i "s|^MemoryMax=.*|# MemoryMax= (not set — sufficient RAM detected)|" \
        /etc/systemd/system/msp-agent.service
fi

systemctl daemon-reload
systemctl enable msp-agent

# ── Verify system binaries ────────────────────────────────────────────────────
info "Verifying installed tools..."

# Format: "binary:package:required(yes/no)"
TOOL_CHECKS=(
    # required — agent will fail or silently return empty results without these
    "python3:python3:yes"
    "pip3:python3-pip:yes"
    # network tasks
    "nmap:nmap:yes"
    "ping:iputils-ping:yes"
    "arp-scan:arp-scan:yes"
    "traceroute:traceroute:yes"
    "mtr:mtr:yes"
    "iperf3:iperf3:yes"
    "dig:dnsutils:yes"
    "nc:netcat-openbsd:yes"
    "iw:iw:yes"
    # packet capture / bandwidth
    "tshark:tshark:yes"
    "tcpdump:tcpdump:yes"
    "nethogs:nethogs:yes"
    "iftop:iftop:yes"
    # SNMP
    "snmpwalk:snmp:yes"
    "snmpget:snmp:yes"
    # AD / Windows enumeration
    "smbclient:smbclient:yes"
    "ldapsearch:ldap-utils:yes"
    "rpcclient:samba-common-bin:yes"
    # optional
    "speedtest-cli:speedtest-cli(pip):no"
)

MISSING_REQUIRED=()
MISSING_OPTIONAL=()

for entry in "${TOOL_CHECKS[@]}"; do
    bin="${entry%%:*}"
    rest="${entry#*:}"
    pkg="${rest%%:*}"
    required="${rest##*:}"

    if ! command -v "$bin" &>/dev/null; then
        if [[ "$required" == "yes" ]]; then
            MISSING_REQUIRED+=("$bin (pkg: $pkg)")
        else
            MISSING_OPTIONAL+=("$bin (pkg: $pkg)")
        fi
    fi
done

if [[ ${#MISSING_REQUIRED[@]} -gt 0 ]]; then
    warn "The following REQUIRED tools are missing — some tasks will fail:"
    for t in "${MISSING_REQUIRED[@]}"; do
        warn "  ✗  $t"
    done
else
    info "All required tools present ✓"
fi

if [[ ${#MISSING_OPTIONAL[@]} -gt 0 ]]; then
    info "Optional tools not found (tasks using them will degrade gracefully):"
    for t in "${MISSING_OPTIONAL[@]}"; do
        info "  –  $t"
    done
fi

# Verify core Python packages importable
info "Verifying Python packages..."
MISSING_PY=()
for pkg in websockets; do
    python3 -c "import $pkg" 2>/dev/null || MISSING_PY+=("$pkg")
done
if [[ ${#MISSING_PY[@]} -gt 0 ]]; then
    error "Required Python package(s) not importable: ${MISSING_PY[*]}. Run: pip3 install -r requirements.txt --break-system-packages"
else
    info "Core Python packages OK ✓"
fi

# ── Start service ─────────────────────────────────────────────────────────────
info "Starting MSP agent..."
systemctl start msp-agent

sleep 3
if systemctl is-active --quiet msp-agent; then
    info "======================================================"
    info " Agent installed and running successfully!"
    info ""
    info " Useful commands:"
    info "   systemctl status msp-agent"
    info "   journalctl -u msp-agent -f"
    info "   tail -f /var/log/msp-agent/agent.log"
    info ""
    if [[ ${#MISSING_REQUIRED[@]} -gt 0 ]]; then
        warn " WARNING: Missing required tools — see above warnings"
    else
        info " All tools verified ✓"
    fi
    info "======================================================"
else
    warn "Service started but may have issues. Check logs:"
    journalctl -u msp-agent --no-pager -n 20
fi
