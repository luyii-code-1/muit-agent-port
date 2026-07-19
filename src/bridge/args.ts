const optionToEnv: Record<string, string> = {
  "--relay": "MESH_RELAY_URL",
  "--node": "MESH_NODE_ID",
  "--code": "MESH_PAIRING_CODE",
  "--cwd": "MESH_DEFAULT_CWD",
  "--inbox": "MESH_INBOX_ROOT",
  "--roots": "MESH_ALLOWED_ROOTS",
  "--labels": "MESH_NODE_LABELS",
  "--roles": "MESH_NODE_ROLES",
  "--codex": "MESH_CODEX_COMMAND",
  "--credentials": "MESH_CREDENTIALS_PATH",
};

export function applyBridgeArgs(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Codex Mesh Bridge

First-time pairing:
  node dist/bridge/index.js --relay ws://SERVER:8787/bridge --node MY-PC --code 123456 --cwd /path/to/projects

Options:
  --relay URL          Relay WebSocket URL
  --node ID            Unique computer name
  --code 123456        One-time pairing code (first start only)
  --cwd PATH           Default project directory
  --inbox PATH         Empty-project inbox for routing=new
  --roots A,B          Allowed project roots (defaults to cwd)
  --labels A,B         Searchable node labels
  --roles A,B          Initial responsibility Role labels
  --codex PATH         Codex executable path
  --credentials PATH   Saved credential file path
`);
    process.exit(0);
  }
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const envName = name ? optionToEnv[name] : undefined;
    if (!envName) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    env[envName] = value;
    index += 1;
  }
}
