# GD Arena – AI Group Discussion Battle

**Problem 2 · Voice AI (speech in, speech out):** a voice-first room for practising group discussions with AI participants.

A student joins a group discussion with four AI participants. Each one has a personality and a voice of its own. The student speaks, and the live transcript streams over a WebSocket to the engine. The AI participants reply out loud. When the round ends, the **Adaptive AI Training Engine** finds the student's weakest skill and rebuilds the next round around it, then measures the improvement.

```
GD Round 1 → Analyze → Identify weakness → Adaptive challenge (Round 2) → Improve → repeat
```

## Run it

You need Node 18 or newer. There is nothing to install.

```bash
node server.js            # or: npm start
# open http://localhost:3000 in Chrome or Edge
```

- Use **Chrome or Edge** for voice input (the Web Speech API).
- Open it on `localhost` or over HTTPS. Browsers only allow the microphone in a secure context.
- Use a different port with `PORT=8080 node server.js`.

**Offline fallback:** if you open `public/index.html` directly, or the server isn't running, the app switches to *Offline mode*. The same engine then runs inside the browser tab. Everything works except the live viewer link.

## The 2-minute judge demo

1. Click **Try Demo** (top right). It adds a sample profile and three sample past sessions, so the dashboard has a trend line.
2. The demo picks *Is AI going to replace jobs?* and the four AI participants open the discussion out loud.
3. A simulated student "speaks" three turns. Words stream into the live transcript and over the WebSocket, and the live performance panel updates as they arrive.
4. Round 1 ends. The engine shows **Your biggest weakness: COUNTERARGUMENTS**, the rule that triggered it, and all nine skill scores.
5. **Challenge Mode** starts. Riya says: *"Some students argue that AI will create more jobs than it destroys. Respond to this argument."*
6. The student answers. Result: **Before 60 → After 78, +18 IMPROVEMENT**. Then come the performance report (overall 77/100), the Communication DNA, XP and badges.

Turn off **Voices** on the demo pill if the room is noisy. The demo then runs in about a minute.

**Show WebSockets live:** during a discussion, click **Share live view** and open the link on a phone or a second laptop on the same network. The viewer watches the discussion in real time, read-only, including the speaker's live transcript.

## What's in the box

| Section | What it does |
|---|---|
| Landing | "Speak. Think. Lead.", feature cards, the engine loop, the voice pipeline |
| Profile | Name, college, year, target, speech accent. Communication Profile with six bars |
| Topics | 8 topics across Technology, Business, Society, Education and Current Affairs, each with difficulty, time and skills tested |
| GD Arena | Participants on the left, discussion feed in the middle, live performance on the right. **Speak**, **Submit Response** and **End Discussion** |
| Adaptive engine | Five weakness rules. The lowest-scoring of the five core skills becomes the target |
| Challenge Mode | A round generated for that weakness: a rebuttal for Counterargument, a demand for proof for Evidence, a flawed argument for Reasoning, a stalled group for Leadership, a 20-second timed entry for Participation |
| Report | Overall score, six skill bars, strengths, areas to improve |
| Communication DNA | Critical Thinker, Collaborator, Leader, Persuader and Active Listener, with a radar chart and a personal description |
| Dashboard | Total GDs, average and best score, improvement %, weakest and strongest skill, progress graph, session history |
| Gamification | XP, levels, streak, 8 badges (First Discussion, Counterargument Master, Confident Speaker, Discussion Leader and more) |

## How the voice works

| Step | Where | How |
|---|---|---|
| Speech in | Browser | Web Speech API `SpeechRecognition` with interim results, plus a Web Audio meter that measures real speaking time and pauses |
| Streaming | WebSocket | Interim transcripts go out about every 300 ms. The server replies with live metrics |
| Barge-in | WebSocket | Starting to speak sends `speaking: on`. The server pauses the AI queue, and whoever is talking is cut off |
| Thinking | Server | Rule-based engine in `shared/engine.js`: persona replies, scoring, adaptive challenges |
| Speech out | Browser | `speechSynthesis` with a different voice, pitch and rate per participant. The client acknowledges each line (`tts:done`) so the next speaker waits for the current one to finish |

Voice also feeds scoring. **Confidence** uses your words per minute, fillers and hedges. **Participation** uses measured speaking time and your share of the airtime. In timed challenges, how quickly you start speaking counts.

**Be honest with judges:** Chrome's speech recognition uses Google's online service, so voice *input* needs internet. Typing always works offline. AI voices use the voices installed in the browser and work offline.

## WebSocket protocol

Messages are JSON over `ws://host/ws`.

Client → server: `hello {role: host|viewer, room}`, `start {topicId, profile}`, `interim {text}`, `speaking {on}`, `turn {text, mode, durationMs, voicedMs, pauses}`, `tts:done {id}`, `end`, `challenge:start`, `challenge:submit {text, latencyMs}`, `challenge:next`, `ping`.

Server → clients: `welcome`, `presence {viewers}`, `session`, `typing {pid}`, `say {id, pid, text}`, `floor`, `bargein`, `live {interim, metrics}`, `user`, `metrics`, `nudge`, `analysis`, `challenge`, `challenge:ready`, `result`, `pong`.

Each host gets a room code. Every event is broadcast to the room, and late viewers get a replay of the event log. The server is about 200 lines of plain Node with no `ws` package: it does the RFC 6455 handshake and framing itself.

If you go quiet for 20 seconds, the AI participants carry the discussion on without you, just like a real GD. That pushes your participation share down.

## Project layout

```
server.js           HTTP + WebSocket server, rooms, live viewers (no dependencies)
shared/engine.js    Topics, AI personas, scoring, adaptive session (runs on server AND in browser)
public/index.html   All views
public/styles.css   Dark glass UI
public/app.js       Transport, voice in/out, rendering, dashboard, gamification, demo
```

## Taking it further

The engine is the single place to plug in real AI later:

- Replace `Session.respond()` with an LLM call to get free-form AI replies.
- Stream microphone audio over the same WebSocket to a server-side speech-to-text service, for accuracy and offline-independent recognition.
- Swap browser text-to-speech for a neural TTS service and stream the audio back.

Progress is stored in the browser's localStorage. There is no database and no login.
