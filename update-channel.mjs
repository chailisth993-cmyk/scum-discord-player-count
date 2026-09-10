import dgram from "node:dgram";

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const serverHost = process.env.SCUM_SERVER_HOST || "149.102.153.19";
const queryPort = Number(process.env.SCUM_QUERY_PORT || 29415);
const serverId = process.env.GAMEMONITORING_SERVER_ID || "11866509";

if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");
if (!channelId) throw new Error("Missing DISCORD_CHANNEL_ID");

async function discord(path, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Discord API ${response.status}: ${detail}`);
  }

  return response.json();
}

function readCString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw new Error("Invalid A2S response");
  return { value: buffer.toString("utf8", offset, end), next: end + 1 };
}

function parseA2SInfo(message) {
  if (message.length < 6 || message.readInt32LE(0) !== -1 || message[4] !== 0x49) {
    throw new Error("Unexpected A2S_INFO response");
  }

  let offset = 6;
  for (let i = 0; i < 4; i++) offset = readCString(message, offset).next;
  offset += 2;
  if (offset + 3 > message.length) throw new Error("Incomplete A2S_INFO response");

  return {
    players: message[offset],
    maxPlayers: message[offset + 1],
  };
}

function queryScumServer(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      error ? reject(error) : resolve(value);
    };

    const sendQuery = (challenge) => {
      const prefix = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]);
      const text = Buffer.from("Source Engine Query\0", "ascii");
      const packet = challenge
        ? Buffer.concat([prefix, text, challenge])
        : Buffer.concat([prefix, text]);
      socket.send(packet, port, host);
    };

    socket.on("error", (error) => finish(error));
    socket.on("message", (message) => {
      try {
        if (message.length >= 9 && message.readInt32LE(0) === -1 && message[4] === 0x41) {
          sendQuery(message.subarray(5, 9));
          return;
        }
        finish(null, parseA2SInfo(message));
      } catch (error) {
        finish(error);
      }
    });

    const timer = setTimeout(
      () => finish(new Error(`SCUM query timed out at ${host}:${port}`)),
      timeoutMs,
    );

    sendQuery();
  });
}

async function queryBattleMetrics() {
  const url = new URL("https://api.battlemetrics.com/servers");
  url.searchParams.set("filter[game]", "scum");
  url.searchParams.set("filter[search]", serverHost);

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`BattleMetrics HTTP ${response.status}`);

  const payload = await response.json();
  const server = payload.data?.find((item) => item.attributes?.ip === serverHost);
  if (!server) throw new Error("Server not found on BattleMetrics");

  const attributes = server.attributes;
  if (attributes.status !== "online") throw new Error("BattleMetrics reports offline");

  return {
    players: Number(attributes.players ?? 0),
    maxPlayers: Number(attributes.maxPlayers ?? 10),
  };
}

async function queryGameMonitoring() {
  const response = await fetch(
    `https://api.gamemonitoring.net/servers/${serverId}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`GameMonitoring HTTP ${response.status}`);

  const payload = await response.json();
  const server = payload.response ?? payload;
  const online =
    server.status === true ||
    server.status === 1 ||
    server.status === "online";

  if (!online) throw new Error("GameMonitoring reports offline");
  return {
    players: Number(server.numplayers ?? 0),
    maxPlayers: Number(server.maxplayers ?? 10),
  };
}

async function getChannelName() {
  try {
    const info = await queryScumServer(serverHost, queryPort);
    console.log(`Direct SCUM query: ${info.players}/${info.maxPlayers}`);
    return `🟢 Players: ${info.players}/${info.maxPlayers}`;
  } catch (directError) {
    console.warn(`Direct query failed: ${directError.message}`);
  }

  try {
    const info = await queryBattleMetrics();
    console.log(`BattleMetrics fallback: ${info.players}/${info.maxPlayers}`);
    return `🟢 Players: ${info.players}/${info.maxPlayers}`;
  } catch (battleMetricsError) {
    console.warn(`BattleMetrics fallback failed: ${battleMetricsError.message}`);
  }

  try {
    const info = await queryGameMonitoring();
    console.log(`GameMonitoring fallback: ${info.players}/${info.maxPlayers}`);
    return `🟢 Players: ${info.players}/${info.maxPlayers}`;
  } catch (monitoringError) {
    console.warn(`Monitoring fallback failed: ${monitoringError.message}`);
    return "🔴 Server Offline";
  }
}

const bot = await discord("/users/@me");
console.log(`Bot identity: ${bot.username} (${bot.id})`);

const desiredName = await getChannelName();
const channel = await discord(`/channels/${channelId}`);

if (channel.name === desiredName) {
  console.log(`No change: ${desiredName}`);
} else {
  await discord(`/channels/${channelId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: desiredName }),
  });
  console.log(`Updated: ${desiredName}`);
}
