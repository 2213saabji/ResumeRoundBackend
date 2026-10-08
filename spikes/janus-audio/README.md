# MVP-4 spike: Janus audio bridge

Throwaway code that answers one question: **how should the interview bot hear the candidate and
speak back through Janus?** Findings and the recommendation are in
[docs/spikes/janus-audio-bridge.md](../../docs/spikes/janus-audio-bridge.md). Nothing here is
imported by the backend.

| Path                 | Runs on      | What                                                                    |
| -------------------- | ------------ | ----------------------------------------------------------------------- |
| `smoke.ts`           | laptop       | Backend `JanusClient` against the server: tokens, admin key, rooms, RTP |
| `token-lifetime.ts`  | laptop       | Shows that Janus checks the token on every request                      |
| `test-page/`         | laptop       | Browser page: echo test, or talk to the bot in room 1001; shows delays  |
| `bot/transport-a.ts` | media server | Prototype A: bot joins the AudioBridge as a plain-RTP participant       |
| `bot/transport-b.ts` | media server | Prototype B: bot joins as a WebRTC peer (werift)                        |
| `bot/turn-bot.ts`    | media server | Shared bot: Opus decode, end-of-speech detection, paced spoken reply    |
| `bot/load-test.ts`   | media server | N rooms, each with a bot and a scripted candidate; delay and CPU        |
| `bot/series.sh`      | media server | The measurement series used in the write-up                             |

The bot folder has its own `package.json` (werift, opusscript) so the backend does not pick up
spike dependencies. It needs `espeak-ng` on the server for the reply clip.

## Run

Laptop (uses the Janus settings in the backend `.env`):

```bash
npx tsx spikes/janus-audio/smoke.ts
npx tsx spikes/janus-audio/token-lifetime.ts
npx tsx spikes/janus-audio/test-page/server.ts      # then open http://localhost:8787
```

Media server (copy `bot/` to `~/janus-audio/bot`, then `npm install` there):

```bash
export $(sudo grep -E "JANUS_TOKEN_SECRET|AUDIOBRIDGE_ADMIN_KEY" /etc/resumeround/secrets.env | xargs)
export BOT_RTP_IP=$(hostname -I | cut -d" " -f1)   # prototype A: an address Janus can send to
npx tsx run-bot.ts a        # or b: one bot in room 1001, talk to it from the test page
npx tsx load-test.ts b 10   # 10 rooms, prototype B
```

Bot settings (environment): `HANGOVER_MS` (silence before the bot replies, default 700),
`THINK_MS` (simulated STT + LLM + TTS time, default 0), `THRESHOLD_DB` (default -45),
`REPLY_TEXT`.

## Test page

- **Echo test**: Janus sends your audio straight back. Say "ta" or clap; the delay is the
  network + Janus round trip.
- **Room 1001 (bot)**: start `run-bot.ts` on the server first. Speak, stop, and the bot answers.
  "Minus bot hangover" is the delay that is not the bot's deliberate wait.
- **Force TURN relay** checks the coturn path (what users on strict networks get).
- Use headphones, otherwise the bot hears its own reply through your mic.
