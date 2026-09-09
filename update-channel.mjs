const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
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

async function getChannelName() {
  try {
    const response = await fetch(
      `https://api.gamemonitoring.net/servers/${serverId}`,
      { headers: { Accept: "application/json" } },
    );

    if (!response.ok) return "🔴 Server Offline";

    const payload = await response.json();
    const server = payload.response ?? payload;
    const online =
      server.status === true ||
      server.status === 1 ||
      server.status === "online";

    if (!online) return "🔴 Server Offline";

    const players = Number(server.numplayers ?? 0);
    const maxPlayers = Number(server.maxplayers ?? 10);
    return `🟢 Players: ${players}/${maxPlayers}`;
  } catch {
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
