export type InstallPlatform = "windows" | "macos" | "linux";

export interface InstallKitOptions {
  platform: InstallPlatform;
  nodeId: string;
  roles: string[];
  pairingCode: string;
  relayHttpUrl: string;
}

export interface InstallKit {
  script: string;
  scriptFilename: string;
  promptMarkdown: string;
  promptFilename: string;
}

export function buildInstallKit(options: InstallKitOptions): InstallKit {
  const bridgeUrl = options.relayHttpUrl.replace(/^http/, "ws") + "/bridge";
  const packageUrl = options.relayHttpUrl + "/download/codex-mesh-mcp.zip";
  const labels = options.roles.join(",");
  const script = options.platform === "windows"
    ? windowsScript(options.nodeId, labels, options.pairingCode, bridgeUrl, packageUrl)
    : unixScript(options.platform, options.nodeId, labels, options.pairingCode, bridgeUrl, packageUrl);
  return {
    script,
    scriptFilename: options.platform === "windows" ? `install-${options.nodeId}.ps1` : `install-${options.nodeId}.sh`,
    promptMarkdown: deploymentPrompt(options, bridgeUrl, packageUrl),
    promptFilename: `INSTALL-${options.nodeId}.md`,
  };
}

function windowsScript(nodeId: string, labels: string, code: string, bridgeUrl: string, packageUrl: string): string {
  return `# Codex Mesh one-click installer for Windows
$ErrorActionPreference = "Stop"
$bridgeRoot = Join-Path $env:LOCALAPPDATA "CodexMesh"
$projectRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Development"
$download = Join-Path $env:TEMP "codex-mesh-mcp.zip"
$extract = Join-Path $env:TEMP ("codex-mesh-" + [guid]::NewGuid())
$nodePath = (Get-Command node -ErrorAction Stop).Source
Get-Command npm -ErrorAction Stop | Out-Null
Get-Command codex -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Force -Path $bridgeRoot,$projectRoot | Out-Null
Invoke-WebRequest ${ps(packageUrl)} -OutFile $download
Expand-Archive $download -DestinationPath $extract -Force
Copy-Item (Join-Path $extract "*") $bridgeRoot -Recurse -Force
Push-Location $bridgeRoot
npm ci --omit=dev
Pop-Location
$startLines = @(
  ${ps(`$env:MESH_RELAY_URL = ${JSON.stringify(bridgeUrl)}`)},
  ${ps(`$env:MESH_NODE_ID = ${JSON.stringify(nodeId)}`)},
  ${ps(`$env:MESH_PAIRING_CODE = ${JSON.stringify(code)}`)},
  '$env:MESH_DEFAULT_CWD = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Development"',
  '$env:MESH_INBOX_ROOT = Join-Path $env:MESH_DEFAULT_CWD ".codex-mesh\\inbox"',
  '$env:MESH_ALLOWED_ROOTS = $env:MESH_DEFAULT_CWD',
  '$env:MESH_NODE_LABELS = "windows,local"',
  ${ps(`$env:MESH_NODE_ROLES = ${JSON.stringify(labels)}`)},
  '$env:MESH_APPROVAL_POLICY = "never"',
  '$env:MESH_SANDBOX = "workspace-write"',
  '$env:MESH_CREDENTIALS_PATH = Join-Path $env:LOCALAPPDATA "CodexMesh\\data\\bridge-credentials.json"',
  '$env:MESH_BRIDGE_DB_PATH = Join-Path $env:LOCALAPPDATA "CodexMesh\\data\\bridge.db"',
  ${ps(`Set-Location ${JSON.stringify("$bridgeRoot")}`)},
  ${ps(`& ${JSON.stringify("$nodePath")} ${JSON.stringify("$bridgeRoot\\dist\\bridge\\index.js")}`)}
)
$startPath = Join-Path $bridgeRoot "start-bridge.ps1"
Set-Content -Path $startPath -Value $startLines -Encoding UTF8
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "CodexMesh.cmd"
Set-Content -Path $launcher -Value ('@powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startPath + '"') -Encoding ASCII
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$startPath)
Write-Host "Codex Mesh installed. Node: ${nodeId}"
Write-Host "Startup launcher: $launcher"
`;
}

function unixScript(platform: "macos" | "linux", nodeId: string, labels: string, code: string, bridgeUrl: string, packageUrl: string): string {
  const service = platform === "macos"
    ? `mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/com.codex.mesh.bridge.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.codex.mesh.bridge</string><key>ProgramArguments</key><array><string>$bridge_root/start-bridge.sh</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$bridge_root/bridge.log</string><key>StandardErrorPath</key><string>$bridge_root/bridge-error.log</string></dict></plist>
PLIST
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.codex.mesh.bridge.plist" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.codex.mesh.bridge.plist"`
    : `mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/codex-mesh.service" <<SERVICE
[Unit]
Description=Codex Mesh Bridge
[Service]
ExecStart=$bridge_root/start-bridge.sh
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
SERVICE
systemctl --user daemon-reload
systemctl --user enable --now codex-mesh.service`;
  return `#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null
command -v npm >/dev/null
command -v codex >/dev/null
bridge_root="$HOME/.local/share/codex-mesh"
project_root="$HOME/Documents/Development"
mkdir -p "$bridge_root" "$project_root"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL ${sh(packageUrl)} -o "$tmp_dir/mesh.zip"
unzip -q "$tmp_dir/mesh.zip" -d "$tmp_dir/package"
cp -R "$tmp_dir/package/." "$bridge_root/"
(cd "$bridge_root" && npm ci --omit=dev)
cat > "$bridge_root/start-bridge.sh" <<'BRIDGE'
#!/usr/bin/env bash
set -euo pipefail
export MESH_RELAY_URL=${sh(bridgeUrl)}
export MESH_NODE_ID=${sh(nodeId)}
export MESH_PAIRING_CODE=${sh(code)}
export MESH_DEFAULT_CWD="$HOME/Documents/Development"
export MESH_INBOX_ROOT="$MESH_DEFAULT_CWD/.codex-mesh/inbox"
export MESH_ALLOWED_ROOTS="$MESH_DEFAULT_CWD"
export MESH_NODE_LABELS=${sh(platform === "macos" ? "macos,local" : "linux,local")}
export MESH_NODE_ROLES=${sh(labels)}
export MESH_APPROVAL_POLICY=never
export MESH_SANDBOX=workspace-write
export MESH_CREDENTIALS_PATH="$HOME/.local/share/codex-mesh/data/bridge-credentials.json"
export MESH_BRIDGE_DB_PATH="$HOME/.local/share/codex-mesh/data/bridge.db"
cd "$HOME/.local/share/codex-mesh"
exec node dist/bridge/index.js
BRIDGE
chmod 700 "$bridge_root/start-bridge.sh"
${service}
echo "Codex Mesh installed. Node: ${nodeId}"
`;
}

function deploymentPrompt(options: InstallKitOptions, bridgeUrl: string, packageUrl: string): string {
  return `# Deploy Codex Mesh Bridge

Install a Codex Mesh Bridge on this computer. Work autonomously, but do not expose credentials in chat or logs.

## Assigned configuration

- Node ID: \`${options.nodeId}\`
- Platform: \`${options.platform}\`
- Initial Role labels: ${options.roles.length ? options.roles.map((role) => `\`${role}\``).join(", ") : "none"}
- Relay WebSocket: \`${bridgeUrl}\`
- Package: \`${packageUrl}\`
- One-time pairing code: \`${options.pairingCode}\` (expires soon and can only be used once)

## Required workflow

1. Read the package's \`install.md\` completely before changing the system.
2. Verify Node.js 20+, npm, and an authenticated \`codex app-server\`.
3. Install under the current user's application-data directory, not inside a code project.
4. Use the user's \`Documents/Development\` directory as the default and allowed project root. Create it if absent.
5. Pair with the configuration above and preserve the generated credentials across upgrades.
6. Install a user-level auto-start service appropriate for ${options.platform}; do not require administrator privileges.
7. Start the Bridge and verify that node \`${options.nodeId}\` remains connected.
8. Report only non-secret paths, versions, service state, and validation results. Never repeat the node token.
`;
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
