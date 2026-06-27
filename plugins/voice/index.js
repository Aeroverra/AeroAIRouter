export const meta = {
  name: "voice",
  label: "Voice",
  description: "Optional voice chat: speech-to-text (whisper) + text-to-speech (edge-tts) in a Discord voice channel.",
};
export const enabledByDefault = false;
export const secrets = [];
export const defaults = { channelId: "", whisperPath: "", edgeTtsPath: "", ttsCacheDir: "/tmp/aeroairouter-tts" };
export const configSchema = [
  { path: "channelId", label: "Voice channel ID", type: "string", help: "The Discord voice channel the bot joins." },
  { path: "whisperPath", label: "Whisper path", type: "string", help: "Path to the whisper executable / python wrapper for speech-to-text." },
  { path: "edgeTtsPath", label: "edge-tts path", type: "string", help: "Path to the edge-tts executable for text-to-speech." },
  { path: "ttsCacheDir", label: "TTS cache dir", type: "string", help: "Where synthesized audio is cached." },
];
