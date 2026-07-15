#!/bin/bash
# This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
# Source of truth lives in PhantomWP infrastructure generators.


# PhantomWP Infrastructure Version
PHANTOMWP_INFRA_VERSION="1.34.0"

# Get the workspace directory (four levels up from .phantomwp/ide/targets/codespaces)
WORKSPACE_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$WORKSPACE_DIR" || {
  echo "❌ Failed to change to workspace directory"
  exit 1
}

echo "🚀 Starting PhantomWP development environment..."
echo "📁 Working directory: $WORKSPACE_DIR"
echo "📦 Infrastructure version: v$PHANTOMWP_INFRA_VERSION"
echo ""

# Ensure version file exists
if [ ! -f ".phantomwp-version" ]; then
  echo "$PHANTOMWP_INFRA_VERSION" > .phantomwp-version
fi

# ============================================================================
# JWT PUBLIC KEY SETUP (Automatic)
# ============================================================================
echo "🔐 Setting up JWT authentication..."

# PhantomWP API URL (used to fetch the public key and for future API calls)
PHANTOMWP_URL="${PHANTOMWP_URL:-https://phantomwp.com}"

# Check if JWT_PUBLIC_KEY is already set (from GitHub Codespaces Secrets)
if [ -n "${JWT_PUBLIC_KEY}" ]; then
  echo "✅ JWT_PUBLIC_KEY found in environment"
else
  # Priority 1: Fetch from PhantomWP API (rolling key support)
  echo "🔍 Fetching JWT public key from PhantomWP API..."
  KEY_RESPONSE=$(curl -s --max-time 10 "${PHANTOMWP_URL}/api/keys/public" 2>/dev/null)
  if [ $? -eq 0 ] && echo "$KEY_RESPONSE" | grep -q '"keys"'; then
    FETCHED_KEY=$(echo "$KEY_RESPONSE" | node -e "
      let d='';
      process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try{const j=JSON.parse(d);if(j.keys&&j.keys[0]&&j.keys[0].key)process.stdout.write(j.keys[0].key);} catch{}
      });
    " 2>/dev/null)
    if [ -n "${FETCHED_KEY}" ] && echo "${FETCHED_KEY}" | grep -q "BEGIN PUBLIC KEY"; then
      JWT_PUBLIC_KEY="${FETCHED_KEY}"
      export JWT_PUBLIC_KEY
      # Cache the fetched key to disk as fallback for offline restarts
      echo "${JWT_PUBLIC_KEY}" > .devcontainer/.jwt-public-key
      echo "✅ JWT_PUBLIC_KEY fetched from API and cached locally"
    else
      echo "⚠️  API response did not contain a valid public key"
    fi
  else
    echo "⚠️  Could not reach PhantomWP API (will fall back to local key file)"
  fi

  # Priority 2: Check persistent key file (survives infrastructure updates and restarts)
  if [ -z "${JWT_PUBLIC_KEY}" ] && [ -f ".devcontainer/.jwt-public-key" ]; then
    echo "🔍 Found persistent JWT key file"
    JWT_PUBLIC_KEY=$(cat .devcontainer/.jwt-public-key)
    
    if [ -n "${JWT_PUBLIC_KEY}" ]; then
      export JWT_PUBLIC_KEY
      echo "✅ JWT_PUBLIC_KEY loaded from .devcontainer/.jwt-public-key"
    else
      echo "⚠️  .devcontainer/.jwt-public-key file is empty"
    fi
  fi
  
  # Priority 3: Check legacy .phantomwp-key file (old injection method)
  if [ -z "${JWT_PUBLIC_KEY}" ] && [ -f ".phantomwp-key" ]; then
    echo "🔍 Found legacy .phantomwp-key file"
    JWT_PUBLIC_KEY=$(cat .phantomwp-key | base64 -d 2>/dev/null || cat .phantomwp-key)
    
    if [ -n "${JWT_PUBLIC_KEY}" ]; then
      export JWT_PUBLIC_KEY
      echo "✅ JWT_PUBLIC_KEY loaded from legacy file"
      
      # Migrate to persistent location
      echo "${JWT_PUBLIC_KEY}" > .devcontainer/.jwt-public-key
      echo "📦 Migrated key to .devcontainer/.jwt-public-key"
      
      # Clean up legacy file
      rm -f .phantomwp-key
      if [ -d ".git" ]; then
        git rm --cached .phantomwp-key 2>/dev/null || true
        git commit -m "Remove temporary JWT key file" 2>/dev/null || true
      fi
    else
      echo "⚠️  Failed to decode .phantomwp-key file"
      rm -f .phantomwp-key
    fi
  fi
  
  # Priority 4: If still not found, show error
  if [ -z "${JWT_PUBLIC_KEY}" ]; then
    echo "❌ JWT_PUBLIC_KEY not found!"
    echo ""
    echo "The JWT public key is required for WebSocket authentication."
    echo ""
    echo "How to fix:"
    echo "  1. Make sure JWT_PUBLIC_KEY is set in main app environment"
    echo "     (The key should be fetched automatically from the PhantomWP API)"
    echo ""
    echo "  2. OR manually set in GitHub Codespaces Secrets:"
    echo "     → Go to: https://github.com/settings/codespaces"
    echo "     → Add secret: JWT_PUBLIC_KEY"
    echo "     → Paste your public key"
    echo ""
    echo "  3. Then restart this codespace"
    echo ""
  fi
fi

# Load CONTAINER_REPO_ID from persistent file
if [ -z "${CONTAINER_REPO_ID}" ] && [ -f ".devcontainer/.container-repo-id" ]; then
  CONTAINER_REPO_ID=$(cat .devcontainer/.container-repo-id)
  if [ -n "${CONTAINER_REPO_ID}" ]; then
    export CONTAINER_REPO_ID
    echo "🔒 CONTAINER_REPO_ID loaded: ${CONTAINER_REPO_ID}"
  fi
fi

# Export PHANTOMWP_URL and JWT_PUBLIC_KEY for PM2 processes
export PHANTOMWP_URL
if [ -n "${JWT_PUBLIC_KEY}" ]; then
  export JWT_PUBLIC_KEY
  echo "🔓 JWT public key configured (RS256 authentication enabled)"
else
  echo "⚠️  JWT public key not available - WebSocket auth will fail"
  echo "   WebSocket server will exit if JWT_PUBLIC_KEY is missing"
fi

echo ""

# ============================================================================
# DEPENDENCY INSTALLATION
# ============================================================================

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

# Check if ws module is available
if [ ! -d "node_modules/ws" ]; then
  echo "⚠️  WebSocket dependency missing, installing..."
  npm install ws chokidar
fi

# Verify PM2 is installed
if ! command -v pm2 &> /dev/null; then
  echo "❌ PM2 not found, installing..."
  npm install -g pm2
fi

# Ensure node-pty is installed for terminal support
if ! node -e "require('node-pty')" 2>/dev/null; then
  echo "📦 Installing node-pty for terminal support..."
  cd "$WORKSPACE_DIR" && npm install node-pty 2>/dev/null || echo "⚠️  node-pty install failed (terminal will use fallback mode)"
fi

# Stop any existing PM2 processes
echo "🧹 Cleaning up any existing processes..."
pm2 delete all 2>/dev/null || true
sleep 2

# Start services with PM2
echo "📡 Starting services with PM2..."
if ! pm2 start .devcontainer/ecosystem.config.cjs; then
  echo "❌ Failed to start PM2 services, retrying..."
  sleep 2
  pm2 start .devcontainer/ecosystem.config.cjs || {
    echo "❌ Failed to start PM2 services after retry"
    echo "Checking PM2 logs..."
    pm2 logs --lines 20 --nostream || true
    echo "Attempting to start services manually..."
    # Try starting services individually as fallback
    pm2 start "$WORKSPACE_DIR/.devcontainer/ws-server.js" --name websocket --cwd "$WORKSPACE_DIR" || true
    pm2 start npm --name astro --cwd "$WORKSPACE_DIR" -- run dev || true
  }
fi

# Make phantomwp-ide CLI available on PATH
chmod +x "$WORKSPACE_DIR/.devcontainer/phantomwp-ide"
if [ ! -L /usr/local/bin/phantomwp-ide ]; then
  sudo ln -sf "$WORKSPACE_DIR/.devcontainer/phantomwp-ide" /usr/local/bin/phantomwp-ide 2>/dev/null ||     ln -sf "$WORKSPACE_DIR/.devcontainer/phantomwp-ide" "$HOME/.local/bin/phantomwp-ide" 2>/dev/null || true
fi

# ============================================================================
# SCREENSHOT HELPER (chrome-headless-shell + puppeteer-core)
# Used by the AI screenshot_preview tool. Installed in the background so
# the first codespace start is not blocked by a ~80MB Chromium download.
# ============================================================================
if [ -f "$WORKSPACE_DIR/.devcontainer/screenshot/install.sh" ]; then
  chmod +x "$WORKSPACE_DIR/.devcontainer/screenshot/install.sh" 2>/dev/null || true
  echo "🖼️  Provisioning screenshot helper in background (chrome-headless-shell)..."
  nohup bash "$WORKSPACE_DIR/.devcontainer/screenshot/install.sh" > "$WORKSPACE_DIR/.devcontainer/screenshot/install.log" 2>&1 &
  disown 2>/dev/null || true
fi

# Save PM2 process list to survive restarts
pm2 save --force || true

# Configure PM2 startup script (may fail in Codespaces, that's OK)
pm2 startup systemd -u $(whoami) --hp $HOME 2>/dev/null || pm2 startup -u $(whoami) --hp $HOME 2>/dev/null || true

# Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 5

# Show PM2 status immediately
echo ""
echo "📊 PM2 Status:"
pm2 list

# Check if services are actually running
if ! pm2 list | grep -q "online"; then
  echo "⚠️  Warning: No PM2 services are online"
  echo "Checking logs for errors..."
  pm2 logs --lines 50 --nostream || true
fi

# Wait for Astro server to be ready
echo "⏳ Waiting for Astro server to be ready..."
ASTRO_READY=false
for i in {1..60}; do
  if curl -s http://localhost:4321 > /dev/null 2>&1; then
    echo "✅ Astro server is ready!"
    ASTRO_READY=true
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    echo "⏳ Still waiting for Astro server... (checking PM2 status)"
    pm2 list
    pm2 logs astro --lines 10 --nostream || true
  fi
done

if [ "$ASTRO_READY" = false ]; then
  echo "⚠️  Astro server did not become ready within 60 seconds"
  echo "Checking PM2 logs..."
  pm2 logs astro --lines 20 --nostream || true
fi

# Check WebSocket server is responding
echo "🔍 Checking WebSocket server..."
WS_READY=false
for i in {1..10}; do
  if lsof -i:8080 > /dev/null 2>&1 || netstat -tuln 2>/dev/null | grep -q ":8080"; then
    echo "✅ WebSocket server is listening on port 8080"
    WS_READY=true
    break
  fi
  sleep 1
done

if [ "$WS_READY" = false ]; then
  echo "⚠️  WebSocket server did not start on port 8080"
  echo "Checking PM2 logs..."
  pm2 logs websocket --lines 20 --nostream || true
fi

# Set ports to public (for GitHub Codespaces)
if command -v gh &> /dev/null && [ -n "$CODESPACE_NAME" ]; then
  echo "🔓 Setting ports to public..."
  # Wait a bit for ports to be forwarded
  sleep 5
  
  # Set ports to public synchronously with retries
  for port in 4321 8080; do
    for attempt in {1..5}; do
      if gh codespace ports visibility "$port:public" -c "$CODESPACE_NAME" 2>/dev/null; then
        echo "✅ Port $port set to public"
        break
      else
        if [ $attempt -lt 5 ]; then
          echo "⏳ Retrying to set port $port to public (attempt $attempt/5)..."
          sleep 2
        else
          echo "⚠️  Failed to set port $port to public after 5 attempts"
        fi
      fi
    done
  done
elif [ -n "$CODESPACE_NAME" ]; then
  echo "⚠️  GitHub CLI not available, ports may need to be set to public manually"
  echo "   Go to the Ports tab and set ports 4321 and 8080 to public"
fi

# Open index.astro in the editor
code src/pages/index.astro 2>/dev/null || true

# Wait a moment for the file to open
sleep 2

# Open preview in Simple Browser (split view)
code --open-url "http://localhost:4321" 2>/dev/null || true

echo ""
echo "🎉 Workspace ready!"
echo "📝 Edit on the left, preview on the right"
echo "🔗 WebSocket: localhost:8080"
echo "🌐 Preview: localhost:4321"
echo ""
echo "Services are managed by PM2 (production-grade process manager)"
echo ""
echo "PM2 Commands:"
echo "  Status:  pm2 list"
echo "  Logs:    pm2 logs"
echo "  Restart: pm2 restart all"
echo "  Stop:    pm2 stop all"
echo ""
echo "Individual logs:"
echo "  WebSocket: pm2 logs websocket"
echo "  Astro: pm2 logs astro"
echo ""

# Unstage managed infrastructure files from git (they shouldn't be committed)
if [ -d ".git" ]; then
  git restore --staged     .devcontainer/startup.sh     .devcontainer/ws-server.js     .devcontainer/ecosystem.config.cjs     .devcontainer/phantomwp-ide     .devcontainer/screenshot     .phantomwp/ide     .phantomwp/infra     .phantomwp-version     public/__phantom_iframe_scripts.js     __phantom_dev_tools.mjs     2>/dev/null || git reset HEAD     .devcontainer/startup.sh     .devcontainer/ws-server.js     .devcontainer/ecosystem.config.cjs     .devcontainer/phantomwp-ide     .devcontainer/screenshot     .phantomwp/ide     .phantomwp/infra     .phantomwp-version     public/__phantom_iframe_scripts.js     __phantom_dev_tools.mjs     2>/dev/null || true
fi
