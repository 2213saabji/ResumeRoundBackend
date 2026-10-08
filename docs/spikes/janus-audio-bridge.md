# Spike: how the interview bot joins the call (Janus audio bridge)

Date: 2026-10-09. Code: [spikes/janus-audio/](../../spikes/janus-audio/README.md). Server:
`resumeround-janus-dev` (see [DEVOPS.md](../DEVOPS.md) and
[infra/dev-server/](../../infra/dev-server/README.md)).

## Summary

- **Question.** The candidate talks to Janus from the browser over WebRTC. How should the bot
  process hear them and speak back?
  - **A:** join the AudioBridge room as a _plain-RTP participant_.
  - **B:** join as an ordinary _WebRTC peer_, using werift (WebRTC written in TypeScript).
- **Recommendation: build on B.**
  - Both options gave the same latency.
  - B costs about 0.8 % of a CPU core more per interview.
  - In exchange, B runs anywhere: a developer laptop, or a bot fleet separate from Janus. It is
    encrypted and reports connection failures.
  - The bot code talks to an `AudioLink` interface, so A can replace B later if bot CPU ever
    becomes the bottleneck. A is about 60 lines.
- **What the bridge costs.**
  - The audio path through Janus and the bot adds **about 56 ms (median), up to about 130 ms
    (p95)** after the candidate stops talking.
  - The real delay is end-of-speech detection: the bot waits for silence, 700 ms in the spike.
    Then the network to the candidate adds its share.
- **Changes from the findings:**
  - Interview rooms use a 2-packet jitter buffer (`default_prebuffering: 2`), which cut p95
    delay by about 160–190 ms. Already in `JanusClient.createAudioRoom`.
  - Rooms stay at 16 kHz: same latency, and Janus uses 19 % less CPU than at 48 kHz.
  - Browser join tokens must outlive the interview, because Janus checks the token on every
    request.

## What was built

| Piece                             | What it does                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TurnBot` (shared by A and B)     | Decodes the room audio (Opus, via `opusscript`). Detects the end of speech with an energy check (above -45 dBFS, then 700 ms of silence). Encodes a spoken reply (espeak-ng) in 20 ms frames. |
| Transport A, `transport-a.ts`     | `join` with `rtp: {ip, port}`. Janus sends the mix, minus the bot's own audio, as RTP over UDP and mixes what comes back.                                                                     |
| Transport B, `transport-b.ts`     | werift `RTCPeerConnection`: offer and answer through the AudioBridge `join`, then ICE, DTLS and SRTP, exactly like a browser.                                                                 |
| Fake candidate, `fake-users.ts`   | Joins as plain RTP, speaks a 5 s clip, and measures from its last voiced frame to the start of the bot's reply in the mix it hears.                                                           |
| Load test, `load-test.ts`         | N private rooms, each with one bot and one fake candidate. Reports the delays and the CPU of the bot process and of Janus.                                                                    |
| Browser test page, `test-page/`   | Echo test, or talk to the bot in room 1001. Shows the network round trip, jitter, the jitter buffer and the heard delay. Has a "force TURN" switch.                                           |
| Backend `JanusClient`, `smoke.ts` | Signed tokens and the AudioBridge admin key; room create and destroy; RTP forward. Checked against the server.                                                                                |

## Results

All runs were on the dev media server, an AWS t3.small (2 vCPU Xeon 8175M). Janus 1.1.2, the
bots and the fake candidates all ran on that one machine. Settings: hangover 700 ms, no
simulated "thinking" time, 5.8 s reply clip.

**How to read the delay columns:**

- _Heard delay_ runs from the candidate's last voiced frame to the start of the reply, as heard
  in the room mix.
- _Overhead_ is the heard delay minus the 700 ms hangover. It covers:
  - Janus's jitter buffers and mixer, in both directions;
  - the bot's decoding and processing;
  - the 20 ms frame timing.
- It **does not include** the internet path or the browser's jitter buffer (see the network
  section below).

| Transport | Rooms | Prebuffer | Room rate | Turns (misses) | Overhead p50 / p95 | Bot processing p95 | Bot CPU per room | Janus CPU (whole process) |
| --------- | ----: | --------: | --------: | -------------: | -----------------: | -----------------: | ---------------: | ------------------------: |
| A         |     1 |         6 |    48 kHz |         15 (0) |        52 / 290 ms |             1.7 ms |            4.4 % |                     5.9 % |
| B         |     1 |         6 |    48 kHz |         15 (0) |        56 / 289 ms |             2.9 ms |            5.9 % |                     6.4 % |
| A         |     1 |         2 |    48 kHz |         15 (0) |         56 / 97 ms |             1.8 ms |            4.5 % |                     6.0 % |
| B         |     1 |         2 |    48 kHz |         15 (0) |        56 / 129 ms |             2.0 ms |            6.0 % |                     6.5 % |
| A         |    10 |         2 |    48 kHz |         80 (0) |        56 / 131 ms |             1.9 ms |            2.9 % |                    47.1 % |
| B         |    10 |         2 |    48 kHz |         80 (0) |        56 / 133 ms |             2.7 ms |            3.7 % |                    51.1 % |
| A         |    10 |         2 |    16 kHz |         80 (0) |        56 / 133 ms |             2.1 ms |            2.7 % |                    38.2 % |
| A         |    25 |         2 |    48 kHz |        150 (0) |   2,667 / 6,574 ms |             3.2 ms |            2.3 % |                    94.9 % |
| B         |    25 |         2 |    48 kHz |       124 (26) |   1,492 / 8,805 ms |             4.1 ms |            2.3 % |                    95.2 % |

CPU figures are percent of one core. The 1-room bot figures include fixed process overhead;
the 10-room figures show the real cost per interview.

### Findings

1. **The transport does not change latency.** A and B have the same median (56 ms) and the same
   p95 within noise. The bot's own work, from end of speech to the first reply frame sent, is
   under 5 ms in every run.
2. **The jitter buffer is the knob that matters.**
   - The AudioBridge default (`default_prebuffering` 6 packets = 120 ms) gave a p95 of about
     290 ms.
   - Setting it to 2 packets brought the p95 down to about 100–130 ms, with no lost turns.
   - `createAudioRoom` now sets 2. If a poor network brings back choppy audio, raise it per
     participant (`prebuffer` on `join`) rather than for the whole room.
3. **16 kHz rooms are cheaper with no latency cost.** Janus used 38 % of a core for 10 rooms at
   16 kHz, against 47 % at 48 kHz. Speech-to-text needs 16 kHz anyway, so rooms stay at the
   16 kHz default.
4. **Capacity: Janus costs about 4 % of a core per interview at 16 kHz.**
   - The bot costs about 3 % with transport A, or 3.7 % with B, using a WebAssembly Opus codec.
     A native libopus binding should be cheaper; that's to be measured in MVP-4.
   - With 25 rooms, this 2-core machine was saturated: Janus, the bots and the fake candidates
     were all on it.
     - Delays jumped to several seconds.
     - B lost 26 of 150 turns, because its connections failed when starved of CPU. A lost none
       but was just as late.
   - A t3 instance also runs on burst CPU credits. **A production media server should be a
     compute-optimised type (c7i or c6i), with the bots on separate machines, and should not
     run near saturation.**
5. **Janus checks the token on every request.** Verified with `token-lifetime.ts`: a session
   created with a 5 s token gets `403` on its keepalive and on attach once the token expires,
   and the session then times out.
   - The browser cannot swap its token mid-call: janus.js sets it once.
   - So the **join token's lifetime must cover the whole interview**: the maximum duration plus a
     margin.
   - The token stays limited to `janus.plugin.audiobridge` and `janus.plugin.textroom`.
   - Interview rooms are private, with a per-interview PIN, so a token alone cannot join someone
     else's room. The bot signs a fresh token for each request, so it isn't affected.
6. **Quirks found in transport A:**
   - The room needs `allow_rtp_participants`.
   - Janus sends RTP to the bot from the server's private IP, so the bot must listen on an
     address Janus can reach (`BOT_RTP_IP`).
   - The bot sends one silent frame on join; the mix started flowing once both of these were in
     place.
   - There is no connection state, so failures only show as missing RTP.
7. **Transport B joins in about 1.2 s** (ICE and DTLS); A joins instantly. Both are fine, since
   the bot joins while the candidate is still connecting.

### Network: the region matters more than the transport

TCP connect times from the developer laptop (Jio, India) in October 2026:

| Region                            | Connect time |
| --------------------------------- | -----------: |
| Mumbai `ap-south-1`               |     50–90 ms |
| Singapore `ap-southeast-1`        |   100–125 ms |
| Sydney `ap-southeast-2` (dev box) |   420–510 ms |

- The candidate hears the reply after: end-of-speech wait + about 56 ms (median) through Janus
  and the bot + one network round trip + the browser's jitter buffer (typically 40–80 ms).
- **With the server in Sydney, that's about 0.45 s more than in Mumbai.**
- **Why the dev box is in Sydney:**
  - The AWS account uses the new simplified sign-up. That gives one region chosen from the
    contact country, and for India it is Sydney.
  - Mumbai needs "Activate advanced features". That can't be undone and **deletes the account's
    spend limit**, so it was declined on 2026-10-09 to keep the $30 hard cap.
  - Development continues in Sydney: everything works, just slower.
  - **Production should run in Mumbai.** That means either activating advanced features then
    (with AWS Budgets replacing the spend limit), or a separate production account created with
    "Sign up for AWS (advanced)".

### Latency budget for voice (target: reply within 2 s, PRD)

| Step                             | Estimate            | Source                                |
| -------------------------------- | ------------------- | ------------------------------------- |
| End-of-speech detection          | 500–700 ms          | Spike (700); STT endpointing in MVP-5 |
| Janus + bot transport            | 56 ms (p95 130)     | Spike                                 |
| Network, Mumbai, both directions | 50–90 ms            | Measured RTT                          |
| Browser jitter buffer            | 40–80 ms            | Typical                               |
| STT final result after endpoint  | 100–300 ms          | To be measured (MVP-5)                |
| LLM first sentence               | 400–800 ms          | To be measured (MVP-5)                |
| TTS first audio                  | 150–300 ms          | To be measured (MVP-5)                |
| **Total**                        | **about 1.3–2.3 s** |                                       |

The transport is the smallest part of the budget. The target is only reachable if speech-to-text,
the LLM and text-to-speech all stream: speak the first sentence while the rest is still being
generated. Detecting the end of speech is the biggest single item to tune.

## Comparison and recommendation

|                             | A: plain RTP participant                      | B: WebRTC peer (werift)                                                             |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Latency                     | Same                                          | Same                                                                                |
| Bot CPU per interview       | about 2.9 %                                   | about 3.7 % (+30 %)                                                                 |
| Janus CPU                   | Baseline                                      | +8 % (SRTP on the bot's leg)                                                        |
| Where the bot can run       | Only on the Janus host or its private network | Anywhere that reaches Janus, including behind NAT (expected; laptop not yet tested) |
| Developer laptop runs a bot | No                                            | Yes                                                                                 |
| Encryption on the bot's leg | None (plain RTP; acceptable inside a VPC)     | DTLS-SRTP                                                                           |
| Failure signal              | None; only missing RTP                        | ICE and DTLS connection state                                                       |
| Join time                   | Instant                                       | about 1.2 s                                                                         |
| Janus room settings         | Needs `allow_rtp_participants`                | None                                                                                |
| Dependencies                | None (`node:dgram`)                           | `werift`: TypeScript, actively maintained, but mostly by one person                 |

**Choose B.**

- The base design scales the bot fleet separately from Janus, and the reconnect and failover
  work (FR-4) needs a connection state to watch.
- Developers can run `npm run dev:bot` against the shared Janus server.
- The extra CPU is about 0.2 of a core for 25 interviews, which is small next to the
  speech-to-text, LLM and text-to-speech costs.
- Keep the `AudioLink` interface, so that A can be dropped in for a co-located bot if bot CPU
  ever matters.
- If werift becomes a problem, `@roamhq/wrtc`, a maintained native WebRTC binding, fits behind
  the same interface.

## MVP-4 design decisions from this spike

- **Rooms:**
  - One private AudioBridge room per interview, at 16 kHz with `default_prebuffering: 2`.
  - Each has a random secret and PIN, and is destroyed when the interview ends.
  - Creating rooms needs the AudioBridge admin key (`AUDIOBRIDGE_ADMIN_KEY`), so the backend is
    the only thing that can.
- **`POST /interviews/:id/join` returns:**
  - `wsUrl`, `room`, `pin`;
  - a Janus token limited to AudioBridge and TextRoom, valid for the interview's maximum length
    plus 15 minutes;
  - `iceServers`: STUN, plus TURN with time-limited credentials of the same lifetime.
- **Bot:**
  - Uses transport B.
  - One Janus WebSocket per bot process with one handle per interview; the spike used one
    socket per bot. It signs a token for each request.
  - Treats a failed connection, or no RTP for a few seconds, as a lost interview so that
    failover can claim it.
- **Turn-taking:** the spike is half duplex (the bot ignores audio while speaking).
  Interrupting the bot (barge-in) and push-to-talk come with MVP-4/5.
- **Opus codec:** try a native libopus binding (`@discordjs/opus`) on Linux and compare CPU
  with `opusscript`.
- **Production media server:** in Mumbai, on a compute-optimised instance type, with bots on
  their own instances.

## Still to check (needs a person with a browser)

1. Run `npx tsx spikes/janus-audio/test-page/server.ts` and open http://localhost:8787.
2. **Echo test:** the connection should reach `connected`, and you should hear yourself back.
   The delay should be about one network round trip plus buffering (about 0.5–0.6 s to Sydney).
3. **Room 1001:** start `npx tsx run-bot.ts b` on the server, speak, stop, and the bot should
   answer. Check "Minus bot hangover" against the overhead plus your network round trip.
4. **Force TURN relay:** it should still connect, with the path showing `relay`. That's the
   coturn path for users on strict networks.
5. Run transport B from a laptop behind NAT, to confirm the "runs anywhere" claim.
