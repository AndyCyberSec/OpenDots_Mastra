# RECAP — migrazione self-hosted con Mastra

Note di lavoro per Andrea. Documento di riepilogo: cosa è stato fatto, cosa
significa in pratica, cosa resta da verificare e come gestire il ramo.

Repo: `AndyCyberSec/OpenDots_Mastra` · Branch: `feature/mastra-self-hosted` ·
Base: `origin/main` (`d4214af`) · Ultimo commit: `1eb4293`

L'upstream `CopilotKit/OpenDots` non è stato toccato. Nessuna PR verso upstream.

---

## 1. In una frase

OpenDots ora esegue gli agenti con **Mastra** e salva **conversazioni, tool call,
approvazioni e memoria in locale** (un solo file SQLite). Non serve più
CopilotKit Intelligence, nessuna chiave cloud, nessuna licenza, nessuna
telemetria. La UI React esistente è rimasta la stessa.

---

## 2. Cosa è stato implementato

| Area                 | Prima                                   | Adesso                                           |
| -------------------- | --------------------------------------- | ------------------------------------------------ |
| Runtime agenti       | CopilotKit `BuiltInAgent` + TanStack AI | Mastra `Agent` per ogni Dot                      |
| Orchestrazione cloud | CopilotKit Intelligence                 | Nessuna                                          |
| Conversazioni        | Intelligence (cloud)                    | Tabelle locali `agent_threads` / `agent_runs`    |
| Memoria agente       | Intelligence                            | `@mastra/memory` + `@mastra/libsql` (`mastra_*`) |
| Provider modello     | OpenAI fisso                            | DeepSeek, Ollama, qualsiasi OpenAI-compatible    |
| Modello per Dot      | No                                      | Sì (campo nel dialog del Dot)                    |
| Skill / Learning     | CopilotKit Learning (hosted)            | Cartelle locali `SKILLS_DIR`                     |
| Slack                | Channels SDK (Intelligence)             | Rimosso (limite documentato)                     |
| Telemetria           | Invio a CopilotKit                      | Nessuna (runtime AG-UI opt-out)                  |
| Trasporto UI         | AG-UI via runtime Intelligence          | AG-UI via runtime MIT in modalità SSE locale     |

### Cosa è rimasto intatto

Spaces, pagine (editor, revisioni, autosave), Dots e permessi, ricerca web
(Parallel o browser isolato), Composio, connessioni MCP con approvazione owner,
computer OpenBot, voce (WebRTC), task pianificati e background, autenticazione
`OWNER_TOKEN` e validazione origin.

### File nuovi principali

- `src/server/agent-runner.ts` — runner SQLite che implementa il contratto
  `LocalThreadEndpointRunner` (thread, messaggi, eventi, replay, stop).
- `src/server/dot-agent.ts` — riscritto: costruisce l'agente Mastra per ogni
  turno mantenendo i controlli di sicurezza esistenti (permessi rivalidati,
  timeout, errori senza credenziali, allowlist tool).
- `src/server/ai.ts` — configurazione provider indipendente (`AI_*`).
- `src/server/tools.ts` — `defineTool` neutro + conversione a `createTool` Mastra
  (Zod e JSON Schema, serve per MCP/Composio).
- `src/server/agent-memory.ts` — Mastra Memory sullo stesso file SQLite.
- `src/server/skills.ts` — libreria skill locale.
- `src/server/db.ts` — migrazioni versionate e transazionali.
- `src/server/telemetry-env.ts` — disattiva la telemetria del runtime SDK prima
  dell'import.
- `src/server/safe-failure.ts` — messaggi d'errore senza dettagli sensibili.

### File rimossi

`src/server/headless.ts`, `src/server/learning.ts`,
`src/server/slack-channel.ts`, `src/server/tanstack-tools.ts` e relativi test.

---

## 3. Configurazione (quello che devi mettere in `.env`)

```env
# DeepSeek
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=la-tua-chiave
AI_MODEL=deepseek-chat

# Ollama (in alternativa)
# AI_PROVIDER=ollama
# AI_BASE_URL=http://127.0.0.1:11434/v1
# AI_MODEL=llama3.1
```

`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` funzionano ancora come
fallback. Opzionali: `AI_MAX_OUTPUT_TOKENS` (default 2200), `AGENT_RUN_TIMEOUT_MS`
(default 90000), `SKILLS_DIR` (default `./skills`).

### Accesso dalla LAN

```env
HOST=0.0.0.0
OWNER_TOKEN=una-stringa-casuale-di-almeno-24-caratteri
APP_ORIGIN=http://192.168.1.x:4310
```

Senza `OWNER_TOKEN` lungo, il server rifiuta di partire su un host esterno.
Non esporre SQLite, Ollama, browser service o OpenBot supervisor su reti non
fidate.

---

## 4. Come si usa

```bash
npm ci
cp .env.example .env     # poi modifica .env
npm run dev              # http://127.0.0.1:5173

npm run build && npm start   # produzione, tutto su :4310
```

Verifiche:

```bash
npm run typecheck
npm test        # 323 test, nessuna chiamata a provider a pagamento
npm run lint
```

I test usano un finto server OpenAI-compatible locale
(`tests/fixtures/fake-model.ts`).

---

## 5. Database

Un solo file: `DATABASE_PATH` (default `data/opendots.sqlite`).

- Tabelle esistenti invariate (Spaces, Dots, pagine, MCP, computer, task…).
- Nuove: `agent_threads` (trascrizione canonica AG-UI), `agent_runs` (eventi
  compattati per replay), `schema_migrations`.
- Mastra crea le sue tabelle `mastra_*` nello stesso file.
- Nessun limite di retention imposto dal framework.

**Backup**: copia `opendots.sqlite` + `-wal` + `-shm` (a app ferma, o tutti e
tre insieme). Dettagli in `docs/DATABASE.md`.

**Upgrade da una installazione precedente**: fai un backup del DB, poi avvia la
nuova versione. Le conversazioni vecchie non erano mai state salvate in locale
(erano su Intelligence), quindi non ci sono dati locali da migrare. Le nuove
conversazioni sono tutte locali.

---

## 6. Test eseguiti e risultato

- `tsc --noEmit`: pulito
- `eslint src tests`: pulito
- `prettier --check`: pulito
- `vitest run`: **323 test passati / 53 file**
- `npm run build`: ok
- Smoke test sul build di produzione: streaming SSE, esecuzione tool,
  persistenza della trascrizione dopo restart, blocco LAN senza token — tutti
  verificati.

Copertura aggiunta: configurazione provider, streaming Mastra, tool server,
hand-off dei tool human-in-the-loop, timeout, errori senza credenziali,
isolamento tra Dot, persistenza/replay/stop del runner, skill locali,
conversione tool, superficie HTTP AG-UI completa, zero richieste di telemetria.

---

## 7. Limiti noti (leggere prima di usarlo in produzione)

1. **Slack rimosso.** Dipendeva dai Channels gestiti da Intelligence. Servirebbe
   una vera app Slack (Socket Mode/Events) che chiami `Platform.turn`.
2. **Automatic Learning rimosso.** Sostituito da cartelle skill locali
   (`SKILLS_DIR`). Nessun apprendimento automatico, nessun upload di evidenze.
   Il campo `learningContainerId` resta nel DB/API per compatibilità ma è
   ignorato.
3. **Memoria semantica disattivata.** La memoria Mastra usa una finestra di 40
   messaggi; il recall vettoriale richiede un modello di embedding (DeepSeek non
   lo offre). Le preferenze owner (`memories`) restano long-term.
4. **Approvazioni a livello applicativo**, non interrupt nativi Mastra. Sono
   comunque persistenti e legate a thread/Dot corretto.
5. **Durabilità = tracciamento stato, non exactly-once.** Un run interrotto
   (crash/lease scaduta) va in **Interrupted** e richiede retry esplicito: non
   viene mai ripetuta automaticamente un'azione potenzialmente già eseguita.
6. **Verifiche live mancanti**: OpenBot reale (browser/file/shell), chiamate
   vocali reali, risposte live DeepSeek/Ollama. L'automazione usa un provider
   finto; queste integrazioni richiedono i tuoi servizi configurati.
7. **`/threads` rename/archive/delete** del runtime richiedono Intelligence e non
   sono esposti nella UI (la lista thread locale funziona).

Dettagli: `docs/MASTRA_MIGRATION.md#known-limitations` e
`docs/ARCHITECTURE_DECISIONS.md`.

---

## 8. Git

```bash
# stato attuale
git log --oneline origin/main..HEAD
git push -u origin feature/mastra-self-hosted   # già fatto

# PR verso IL TUO fork (non upstream), quando vuoi
gh pr create --base main --head feature/mastra-self-hosted \
  --title "Self-hosted Mastra migration: local agents, conversations, and memory"
```

Regole rispettate: nessun commit su `main`, nessun force push, nessuna PR verso
`CopilotKit/OpenDots`, licenza MIT e attribuzione preservati, nessun secret
committato (`data/`, `.env`, `.scratch/`, `node_modules` sono ignorati).

### Nota sull'ambiente locale

Durante il lavoro `npm install` era lentissimo perché il repo sta su un volume
SMB (`/Volumes/Scripts`). Le dipendenze sono state installate in
`~/.cache/opendots-deps/node_modules` con un symlink locale `node_modules`
(gitignorato, non committato). Su un disco locale basta `npm ci` normale. Se
vuoi ripristinare:

```bash
rm node_modules
npm ci
```

---

## 9. Prossimi passi suggeriti (in ordine di valore)

1. Provare una conversazione reale con DeepSeek e una con Ollama, poi salvare
   una pagina e riavviare l'app per verificare la persistenza.
2. Verificare OpenBot con i tuoi container (browser, file, shell) e la voce con
   la tua chiave.
3. Aggiungere 2–3 skill vere in `skills/` e attivare il toggle sul Dot.
4. Se ti serve Slack: app Slack con Socket Mode → `Platform.turn` + allowlist.
5. Se vuoi memoria semantica: configurare un embedder (es. Ollama con
   `nomic-embed-text`) e riabilitare `semanticRecall` in `agent-memory.ts`.
6. Decidere se aprire la PR di merge su `main` del fork.

---

## 10. Documenti utili

- `docs/MASTRA_MIGRATION.md` — matrice di compatibilità, architettura, limiti.
- `docs/ARCHITECTURE_DECISIONS.md` — ADR (perché Mastra, perché il runtime SSE,
  perché il runner SQLite, ecc.).
- `docs/DATABASE.md` — schema, migrazioni, backup e recovery.
- `docs/SKILLS.md` — formato skill locali e regole di sicurezza.
- `docs/LICENSE_AUDIT.md` — verifica licenze dipendenze.
- `docs/SETUP.md` — guida setup self-hosted completa.
