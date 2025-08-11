#!/usr/bin/env bash

# Agent-MCP Node Testing Suite
# Mirrors testing-suite/run-test.sh using the Node server implementation

set -euo pipefail

# -----------------------------
# Configuration & helpers
# -----------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_ROOT="$SCRIPT_DIR/tests-node"
TEST_DIR="$TEST_ROOT/test-1"
DEFAULT_PORT=8102

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

find_available_port() {
  local port=$DEFAULT_PORT
  while netstat -tuln 2>/dev/null | grep -q ":$port "; do
    ((port++))
  done
  echo "$port"
}

session_exists() {
  tmux has-session -t "$1" 2>/dev/null
}

cleanup() {
  local exit_code=$?
  log_info "Cleaning up..."

  if session_exists "agentmcp-node-test"; then
    log_info "Terminating Node MCP server session"
    tmux kill-session -t "agentmcp-node-test" 2>/dev/null || true
  fi
  if session_exists "claude-test"; then
    log_info "Terminating Claude session"
    tmux kill-session -t "claude-test" 2>/dev/null || true
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

wait_for_server() {
  local port=$1
  local max_attempts=120
  local attempt=0
  log_info "Waiting for Node MCP server to start on port $port..."
  while [[ $attempt -lt $max_attempts ]]; do
    # Prefer HTTP health check
    if command -v curl >/dev/null 2>&1; then
      local code
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/health" || true)
      if [[ "$code" == "200" ]]; then
        log_success "MCP /health is responding on port $port!"
        return 0
      fi
    else
      # Fallback to port check
      if netstat -tuln 2>/dev/null | grep -q ":$port "; then
        log_success "MCP server is listening on port $port!"
        return 0
      fi
    fi
    ((attempt++))
    sleep 0.5
    echo -n "."
  done
  echo
  log_error "MCP server failed to start after $max_attempts attempts"
  # Dump last 200 lines of server tmux logs for debugging
  if session_exists "agentmcp-node-test"; then
    echo "----- MCP Server Logs (last 200 lines) -----"
    tmux capture-pane -t "agentmcp-node-test" -p | tail -n 200 || true
    echo "-------------------------------------------"
  fi
  return 1
}

extract_admin_token() {
  local session=$1
  local max_attempts=60
  local attempt=0
  log_info "Extracting admin token from Node MCP server output..."
  while [[ $attempt -lt $max_attempts ]]; do
    local buffer
    buffer=$(tmux capture-pane -t "$session" -p 2>/dev/null || echo "")
    # Look for a long hex token line (Node prints the token block with the token on a line)
    local token
    token=$(echo "$buffer" | grep -oE "\b[0-9a-fA-F]{16,}\b" | tail -1 || true)
    if [[ -n "$token" ]]; then
      echo "$token"
      return 0
    fi
    ((attempt++))
    sleep 0.5
  done
  log_error "Could not extract admin token from server output"
  return 1
}

# -----------------------------
# Argument parsing
# -----------------------------
PORT=""
PROJECT_DIR=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      PORT="$2"; shift 2 ;;
    --project-dir)
      PROJECT_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--port PORT] [--project-dir DIR]"
      exit 0 ;;
    *)
      log_error "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$PORT" ]]; then
  PORT=$(find_available_port)
fi
if [[ -z "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$TEST_DIR/project"
fi

# -----------------------------
# Prepare test project directory
# -----------------------------
log_info "Preparing test directory: $TEST_DIR"
rm -rf "$TEST_DIR" 2>/dev/null || true
mkdir -p "$PROJECT_DIR"

cat > "$PROJECT_DIR/README.md" << EOF
# Node Test Project

This is a test project for Agent-MCP Node testing suite.

Created: $(date)
Port: $PORT
EOF

# -----------------------------
# Checks
# -----------------------------
if ! command -v tmux &> /dev/null; then
  log_error "tmux is required but not installed. Please install tmux first."
  exit 1
fi
if ! command -v claude &> /dev/null; then
  log_warning "claude CLI not found. The script will start the server but skip Claude integration."
fi

# -----------------------------
# Build once (outside tmux) for speed
# -----------------------------
log_info "Building Node server (one-time)..."
( cd "$REPO_ROOT/agent-mcp-node" && npm run -s build )

# -----------------------------
# Start Node MCP server
# -----------------------------
log_info "Starting Node MCP server in tmux session 'agentmcp-node-test'..."
TMUX_SERVER_SESSION="agentmcp-node-test"

tmux new-session -d -s "$TMUX_SERVER_SESSION" -c "$REPO_ROOT/agent-mcp-node"
# Start server only (already built)
START_CMD="node build/examples/server/agentMcpServer.js --port $PORT --project-dir '$PROJECT_DIR'"
log_info "Running: $START_CMD"
tmux send-keys -t "$TMUX_SERVER_SESSION" "$START_CMD" Enter

# Wait for server readiness
wait_for_server "$PORT"

# Extract admin token from logs
ADMIN_TOKEN=""
if ! ADMIN_TOKEN=$(extract_admin_token "$TMUX_SERVER_SESSION"); then
  log_warning "Falling back: admin token not found yet; continuing without it."
fi

log_success "Server running at: http://localhost:$PORT"
if [[ -n "$ADMIN_TOKEN" ]]; then
  log_success "Admin token extracted: $ADMIN_TOKEN"
fi

# -----------------------------
# Optionally set up Claude Code
# -----------------------------
if command -v claude &> /dev/null; then
  log_info "Setting up Claude Code session..."
  tmux new-session -d -s "claude-test" -c "$PROJECT_DIR"
  sleep 1

  # Add MCP server to Claude (transport kept as provided; Node serves /mcp)
  # If your environment requires a different transport, adjust -t accordingly.
  tmux send-keys -t "claude-test" "claude mcp add -t sse AgentMCP-Node http://localhost:$PORT/mcp" Enter
  sleep 2

  # Start Claude
  tmux send-keys -t "claude-test" "claude" Enter
  sleep 3

  if [[ -n "$ADMIN_TOKEN" ]]; then
    # Initialize admin agent message
    read -r -d '' ADMIN_INIT_MESSAGE << EOM || true
You are the admin agent.
Admin Token: $ADMIN_TOKEN

Your role is to:
- Coordinate all development work
- Create and manage worker agents
- Maintain project context
- Assign tasks based on agent specializations

TESTING INSTRUCTIONS:
1. Create a task for building a feature
2. Create a worker agent and assign the task
3. Monitor completion and watch the testing agent auto-launch

Query the project RAG for current status and begin coordination.
EOM

    tmux send-keys -t "claude-test" "$ADMIN_INIT_MESSAGE"
    sleep 1
    tmux send-keys -t "claude-test" Enter
  fi

  # Write summary file
  mkdir -p "$TEST_DIR"
  cat > "$TEST_DIR/test-info.txt" << EOF
Agent-MCP Node Test Environment
Created: $(date)

Configuration:
- Port: $PORT
- Project Directory: $PROJECT_DIR
- Admin Token: ${ADMIN_TOKEN:-unknown}

Tmux Sessions:
- MCP Server: agentmcp-node-test
- Claude Code: claude-test

Commands to access:
- MCP Server: tmux attach-session -t agentmcp-node-test
- Claude Code: tmux attach-session -t claude-test
EOF

  log_success "Test environment is ready!"
  if [[ "${NO_ATTACH:-0}" == "1" ]]; then
    log_warning "NO_ATTACH=1 set. Not attaching to Claude; server left running."
    trap - EXIT INT TERM
    exit 0
  fi
  echo -e "${YELLOW}Attaching to Claude Code session...${NC}"
  exec tmux attach-session -t "claude-test"
else
  # No Claude: attach to MCP server session so it stays alive interactively
  mkdir -p "$TEST_DIR"
  cat > "$TEST_DIR/test-info.txt" << EOF
Agent-MCP Node Test Environment (No Claude)
Created: $(date)

Configuration:
- Port: $PORT
- Project Directory: $PROJECT_DIR
- Admin Token: ${ADMIN_TOKEN:-unknown}

Tmux Sessions:
- MCP Server: agentmcp-node-test

Commands to access:
- MCP Server: tmux attach-session -t agentmcp-node-test
EOF
  if [[ "${NO_ATTACH:-0}" == "1" ]]; then
    log_warning "NO_ATTACH=1 set. Not attaching; server left running in tmux 'agentmcp-node-test'."
    trap - EXIT INT TERM
    exit 0
  fi
  log_warning "Claude CLI not found; attaching to MCP server logs..."
  exec tmux attach-session -t agentmcp-node-test
fi 