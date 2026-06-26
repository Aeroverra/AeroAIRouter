import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} from "@discordjs/voice";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, createWriteStream } from "fs";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import config from "../config/index.js";

const VOICE_CHANNEL_ID = config.voice.channelId || "";
const TTS_CACHE_DIR = config.voice.ttsCacheDir || "/tmp/aeroairouter-tts";
const WHISPER_VENV =
  config.voice.whisperPath || process.env.WHISPER_PYTHON || join(process.env.HOME || "", ".whisper-venv/bin/python3");
const EDGE_TTS =
  config.voice.edgeTtsPath || process.env.EDGE_TTS || join(process.env.HOME || "", ".local/bin/edge-tts");

let connection = null;
let player = null;
let voiceCheckInterval = null;
let discordClient = null;
let handleMessageFn = null;
let listening = true;
const activeListeners = new Map();

function ensureTtsDir() {
  if (!existsSync(TTS_CACHE_DIR)) mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

async function generateTts(text) {
  ensureTtsDir();
  const outFile = join(TTS_CACHE_DIR, `tts-${Date.now()}.mp3`);
  try {
    execSync(
      `${EDGE_TTS} --text ${JSON.stringify(text)} --voice en-US-AriaNeural --write-media ${outFile}`,
      { timeout: 15000, stdio: "pipe" }
    );
    return outFile;
  } catch (err) {
    console.error("[voice] TTS generation failed:", err.message);
    return null;
  }
}

async function transcribeAudio(pcmFile) {
  const wavFile = pcmFile.replace(".pcm", ".wav");
  try {
    execSync(
      `ffmpeg -y -f s16le -ar 48000 -ac 1 -i "${pcmFile}" "${wavFile}" 2>/dev/null`,
      { timeout: 10000 }
    );

    const result = execSync(
      `${WHISPER_VENV} -c "
from faster_whisper import WhisperModel
model = WhisperModel('base', device='cpu', compute_type='int8')
segments, _ = model.transcribe('${wavFile}', language='en', beam_size=1)
text = ' '.join(s.text.strip() for s in segments)
print(text)
"`,
      { encoding: "utf8", timeout: 30000 }
    );

    try { unlinkSync(pcmFile); } catch {}
    try { unlinkSync(wavFile); } catch {}

    return result.trim();
  } catch (err) {
    console.error("[voice] Transcription failed:", err.message);
    try { unlinkSync(pcmFile); } catch {}
    try { unlinkSync(wavFile); } catch {}
    return null;
  }
}

function startListeningToUser(userId, displayName) {
  if (!connection || activeListeners.has(userId)) return;

  const receiver = connection.receiver;
  let audioChunks = [];
  let silenceTimer = null;
  let recording = false;
  const SILENCE_THRESHOLD_MS = 1500;

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  opusStream.on("data", (chunk) => {
    if (!listening) return;

    if (!recording) {
      recording = true;
      audioChunks = [];
      console.log(`[voice] ${displayName} started speaking`);
    }

    audioChunks.push(chunk);

    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      if (!recording || audioChunks.length < 5) {
        recording = false;
        audioChunks = [];
        return;
      }

      recording = false;
      const chunks = [...audioChunks];
      audioChunks = [];

      console.log(`[voice] ${displayName} stopped speaking (${chunks.length} packets)`);

      ensureTtsDir();
      const pcmFile = join(TTS_CACHE_DIR, `recv-${Date.now()}.pcm`);

      try {
        const { OpusEncoder } = await import("@discordjs/opus").catch(() => ({ OpusEncoder: null }));
        let decoder;
        if (OpusEncoder) {
          decoder = new OpusEncoder(48000, 1);
        } else {
          const prism = await import("prism-media");
          decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
        }

        const ws = createWriteStream(pcmFile);
        for (const opusPacket of chunks) {
          try {
            let pcm;
            if (decoder.decode) {
              pcm = decoder.decode(opusPacket);
            } else {
              continue;
            }
            ws.write(pcm);
          } catch {}
        }
        ws.end();

        await new Promise((r) => ws.on("finish", r));

        const transcript = await transcribeAudio(pcmFile);
        if (!transcript || transcript.length < 2) return;

        console.log(`[voice] ${displayName} said: "${transcript}"`);

        const wakeWord = (config.discord.wakeWord || "").toLowerCase();
        const mentioned = wakeWord ? transcript.toLowerCase().includes(wakeWord) : false;
        const isOwner = userId === config.discord.ownerId;

        if (mentioned || isOwner) {
          if (handleMessageFn && discordClient) {
            const guild = discordClient.guilds.cache.get(config.discord.guilds.public.id);
            const textChannel = guild?.channels.cache.get(config.discord.guilds.public.channels.general);
            const member = guild?.members.cache.get(userId);

            if (textChannel && member) {
              listening = false;

              const response = await handleMessageFn(
                transcript,
                userId,
                textChannel,
                member.user,
                null
              );

              if (response) {
                await speak(response);
                const truncated = response.length > 300 ? response.substring(0, 297) + "..." : response;
                textChannel.send(`(voice) **${displayName}**: ${transcript}\n(voice) **Azula**: ${truncated}`).catch(() => {});
              }

              listening = true;
            }
          }
        }
      } catch (err) {
        console.error(`[voice] Processing error for ${displayName}:`, err.message);
      }
    }, SILENCE_THRESHOLD_MS);
  });

  activeListeners.set(userId, opusStream);
  console.log(`[voice] Listening to ${displayName}`);
}

function stopListeningToUser(userId) {
  const stream = activeListeners.get(userId);
  if (stream) {
    stream.destroy();
    activeListeners.delete(userId);
  }
}

export async function joinVoiceChannel_(channelId, guildId) {
  try {
    const guild = discordClient?.guilds.cache.get(guildId || config.discord.guilds.public.id);
    if (!guild) return false;

    const targetChannel = channelId || VOICE_CHANNEL_ID;
    const voiceChannel = guild.channels.cache.get(targetChannel);
    if (!voiceChannel) return false;

    if (connection) connection.destroy();

    connection = joinVoiceChannel({
      channelId: targetChannel,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    player = createAudioPlayer();
    connection.subscribe(player);

    await entersState(connection, VoiceConnectionStatus.Ready, 10000);
    console.log(`[voice] Connected to ${voiceChannel.name}`);

    for (const [memberId, member] of voiceChannel.members) {
      if (!member.user.bot) {
        startListeningToUser(memberId, member.displayName);
      }
    }

    return true;
  } catch (err) {
    console.error("[voice] Failed to join:", err.message);
    return false;
  }
}

export async function joinVoice(client) {
  discordClient = client;
  return joinVoiceChannel_(VOICE_CHANNEL_ID);
}

export async function speak(text) {
  if (!connection || !player) {
    return { success: false, error: "Not connected to voice" };
  }

  listening = false;
  const audioFile = await generateTts(text);
  if (!audioFile) {
    listening = true;
    return { success: false, error: "TTS generation failed" };
  }

  try {
    const resource = createAudioResource(audioFile);
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Idle, 60000);
    try { unlinkSync(audioFile); } catch {}
    listening = true;
    return { success: true };
  } catch (err) {
    listening = true;
    console.error("[voice] Playback error:", err.message);
    return { success: false, error: err.message };
  }
}

export function setupVoiceAutoJoin(client, msgHandler) {
  discordClient = client;
  handleMessageFn = msgHandler;

  client.on("voiceStateUpdate", async (oldState, newState) => {
    const userId = newState.member?.id || oldState.member?.id;
    if (!userId || userId === client.user.id) return;

    const guildId = config.discord.guilds.public.id;
    if (newState.guild?.id !== guildId && oldState.guild?.id !== guildId) return;

    const joinedChannel = newState.channelId && (!oldState.channelId || oldState.channelId !== newState.channelId);
    const leftChannel = oldState.channelId && !newState.channelId;

    if (joinedChannel && newState.channel) {
      const nonBotMembers = newState.channel.members.filter((m) => !m.user.bot);

      if (nonBotMembers.size >= 1 && !isInVoice()) {
        console.log(`[voice] ${newState.member.displayName} joined ${newState.channel.name}, auto-joining`);
        await joinVoiceChannel_(newState.channel.id, guildId);
        setTimeout(() => speak(`Hey ${newState.member.displayName}`), 2000);
      } else if (isInVoice()) {
        startListeningToUser(userId, newState.member.displayName);
      }
    }

    if (leftChannel) {
      stopListeningToUser(userId);

      if (isInVoice() && oldState.channel) {
        const nonBotMembers = oldState.channel.members.filter((m) => !m.user.bot);
        if (nonBotMembers.size === 0) {
          console.log("[voice] Everyone left voice, disconnecting");
          leaveVoice();
        }
      }
    }
  });

  console.log("[voice] Auto-join listener active");
}

export function startVoiceMonitor() {
  console.log("[voice] Queue monitor active");
}

export function stopVoiceMonitor() {
  if (voiceCheckInterval) {
    clearInterval(voiceCheckInterval);
    voiceCheckInterval = null;
  }
  for (const [userId] of activeListeners) {
    stopListeningToUser(userId);
  }
  if (connection) {
    connection.destroy();
    connection = null;
  }
}

export function leaveVoice() {
  for (const [userId] of activeListeners) {
    stopListeningToUser(userId);
  }
  if (connection) {
    connection.destroy();
    connection = null;
    player = null;
    console.log("[voice] Disconnected from voice");
  }
}

export function isInVoice() {
  return connection !== null;
}
