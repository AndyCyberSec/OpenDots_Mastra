# RECAP — OpenDots self-hosted (local intelligence)

Note di lavoro per Andrea. Riepilogo di cosa è stato fatto su questo branch, cosa
è stato riutilizzato dal branch Mastra, cosa resta da verificare e come gestirlo.

Repo: `AndyCyberSec/OpenDots_Mastra` · Branch: `feature/opendots-local-intelligence`
· Base: `origin/main` (`d4214af`) · Branch Mastra preservato:
`feature/mastra-self-hosted` (non toccato, solo riferimento).

Nessuna modifica a `CopilotKit/OpenDots`. Nessuna PR upstream.

---

## 1. Direzione corretta

Il branch precedente aveva sostituito l'engine degli agenti con Mastra. Questo
branch **torna all'architettura originale di OpenDots** e rimuove solo
CopilotKit Intelligence:

- React + CopilotKit React SDK + AG-UI: invariati.
- **TanStack AI** (`BuiltInAgent`, adapter OpenAI-compatible): invariato.
- Tool originali (pagine, MCP, Composio, computer, ricerca, voce): invariati.
- SQLite esistente per workspace, pagine, Dots, task, approvazioni: invariato.
- OpenBot, approvazioni, scheduling, background runner: invariati.

Sostituzioni solo per ciò che dipendeva da Intelligence:

| Funzione Intelligence                   | Sostituto locale                                                        |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Thread e persistenza conversazioni      | `SqliteAgentRunner` + `agent_threads` / `agent_runs`                    |
| Replay / `connect` / lista thread       | Endpoint locali del runtime SSE                                         |
| Esecuzione headless (voce, task, Slack) | `Platform.turn` sullo stesso runner                                     |
| Automatic Learning                      | `LearningService` locale (evidence, analisi, review, publish, delivery) |
| Slack Channels                          | Adapter diretto Socket Mode (`@slack/socket-mode` + `@slack/web-api`)   |
| Telemetria setup                        | Rimossa (nessun invio)                                                  |

Mastra non è più una dipendenza: `package.json` non contiene `@mastra/*` né
`@ag-ui/mastra`. Il runtime CopilotKit è usato solo in **modalità SSE locale**
(licenza MIT, nessuna istanza `CopilotKitIntelligence`).

---

## 2. Cosa è stato riutilizzato dal branch Mastra

Riutilizzato (adattato, senza Mastra):

- `agent-runner.ts` — runner SQLite con persistenza transazionale, replay,
  stop, lista thread, migrazioni.
- `db.ts` — migrazioni versionate (`schema_migrations`), ora con le tabelle
  Learning e Slack.
- `ai.ts` — configurazione provider (adattata all'adapter TanStack).
- `safe-failure.ts`, `telemetry-env.ts`, `setup-telemetry.ts` (no-op locale).
- `page-service.ts` — conversazioni pagina locali.
- Test: runner, HTTP end-to-end, provider config, telemetria, page service,
  fake model server.

Non riutilizzato: `dot-agent.ts` Mastra, `agent-memory.ts`, `skills.ts` (cartelle
file), e tutte le dipendenze Mastra. L'Automatic Learning è stata reimplementata
con la semantica originale (container, evidence, review, delivery), non con
semplici cartelle skill.

---

## 3. Funzionalità ripristinate rispetto al branch Mastra

- **TanStack AI** come engine (non Mastra).
- **Automatic Learning**: container per Dot congelato nella conversazione,
  raccolta evidence, proposta skill via modello, review owner, publish/reject,
  delivery con gli stessi tool `copilotkit_load_skill` /
  `copilotkit_read_skill_file`.
- **Slack diretto**: menzione → subscribe thread → conversazione locale
  persistente, allowlist workspace/canale/utenti, Dot selezionabile, pausa,
  risposte serializzate per thread, errori sanitizzati.
- **Modello per Dot** (override) mantenuto.
- **Voce e task pianificati** usano la stessa conversazione locale.

---

## 3b. Hardening (iterazione successiva)

Dopo la migrazione è stato fatto un passaggio di affidabilità e completezza:

**Esecuzione durevole**

- Ogni run crea una riga `agent_runs` con stato `running` prima di chiamare il
  modello e scrive gli eventi AG-UI in un journal append-only
  (`agent_run_events`), con seq per thread, in transazioni batch (64 eventi o
  250 ms). La trascrizione viene checkpointata sugli stessi flush, mai a ogni
  token.
- Gli eventi terminali, lo stato finale (completed/failed/cancelled/interrupted)
  e la trascrizione finale sono committati **prima** di inviare `RUN_FINISHED`.
  Se la scrittura fallisce il client riceve `RUN_ERROR`: non viene mai
  dichiarato un successo non salvato. Eventi oltre `AGENT_MAX_EVENT_BYTES`
  fanno fallire il run.
- Al riavvio i run rimasti `running` diventano `interrupted` con gli eventi già
  committati intatti. Nessun retry automatico di azioni non idempotenti.
- Un run concorrente sullo stesso thread viene rifiutato (memoria + DB); un run
  che ignora l'abort viene finalizzato forzatamente dopo 2,5 s.
- I run del vecchio schema (`agent_runs.events` JSON) restano replayabili dopo
  l'upgrade.

**Streaming con memoria limitata**

- Niente più `ReplaySubject(Infinity)`: subject semplici per lo streaming live e
  ring buffer di 512 eventi usato solo dai client che si riconnettono.
- `/connect` rilegge il journal a chunk da 500 righe, unisce il ring per gli
  eventi non ancora flushati e poi si aggancia al live, senza duplicati.
- La cronologia completa sta in SQLite e non viene mai troncata dai buffer.

**Gestione conversazioni**

- Nuove API owner `/api/conversations`: lista paginata (cursor), ricerca su
  titolo e contenuto dei messaggi, rinomina, archivia/ripristina, elimina.
- La sidebar mantiene l'aspetto originale e aggiunge ricerca, vista archivio,
  "load more" e menu per conversazione (Rename/Archive/Restore/Delete con
  conferma).
- La cancellazione rifiuta se un run è attivo, annulla i task pianificati
  collegati e rimuove in una transazione binding, trascrizione, run, journal,
  review/binding pagina, capture, calls, task link, evidence Learning e
  subscription Slack. Le pagine restano.
- Le conversazioni archiviate rifiutano nuovi turni finché non vengono
  ripristinate.

**Automatic Learning opzionale**

- Nuove impostazioni (default **off**): `learningAutoAnalyze`,
  `learningIntervalMinutes` (5–10080, default 60). Interfaccia in Settings.
- L'analisi automatica usa il **runner di background esistente** (nessun secondo
  scheduler), analizza al massimo un container per tick, rispetta pausa
  workspace/container, soglia di readiness, presenza di nuova evidence e
  intervallo minimo.
- Non ripete l'analisi su evidence invariata; memorizza `lastAutoAttemptAt`,
  `lastAutoError`, `analyzedEvidenceAt`, `analyzedEvidenceCount` (persistenti al
  riavvio). Un'analisi rimasta `running` dopo un crash viene marcata fallita e
  non ritentata.
- L'analisi automatica crea **solo bozze**: non pubblica, non modifica skill
  pubblicate, non tocca istruzioni/permessi/tool dei Dot. La pubblicazione resta
  manuale. Analisi manuale sempre disponibile; analisi sovrapposte sulla stessa
  container vengono rifiutate.
- Il pannello Learning mostra stato automatico, prossima eleggibilità, esito e
  ultimo errore.

**Revisione finale (edge case)**

- Finalizzazione idempotente: un primo `finalize` (completamento, errore o stop
  forzato dopo 2,5 s) vince e marca il run come finalizzato. Eventi tardivi e una
  risoluzione tardiva dell'agente non scrivono più nulla e non possono
  sovrascrivere lo stato terminale. Anche `close()` marca il run finalizzato prima
  di registrare `interrupted`, quindi un completamento tardivo dopo lo shutdown non
  lo trasforma in `completed`.
- L'endpoint inspector `/threads/:id/events` (che per interfaccia deve restituire
  un array) è limitato da `AGENT_THREAD_EVENTS_LIMIT` (default 10000) con un evento
  `CUSTOM` `opendots.history_truncated`; la cronologia in SQLite non viene
  cancellata e `/connect` (percorso chat) continua a riprodurre tutto a chunk da
  500 righe. `getThreadState` legge solo l'ultimo `STATE_SNAPSHOT` (query limitata)
  invece di materializzare l'intera conversazione.
- Test di regressione dedicati: corsa stop forzato/completamento tardivo, evento
  tardivo ignorato, stato non sovrascritto, shutdown con risoluzione tardiva,
  endpoint limitato con replay completo via `/connect`, snapshot di stato oltre il
  limite.

**Dot dinamici e delega (estensione)**

- I Dot ora si possono **eliminare** dal dialog: il server rifiuta se è l'ultimo
  Dot o se una sua conversazione ha un run attivo; annulla i task pianificati
  collegati e rimuove in una transazione conversazioni, trascrizioni, journal,
  approvazioni, capture, calls, task link, evidence Learning, subscription Slack,
  connessioni MCP, permessi/audit computer e deleghe. Le pagine salvate restano
  nello Space.
- **Delega tra Dot** opt-in: archi espliciti tra **ID stabili** (`dot_delegations`),
  quindi rinominare non rompe nulla e i Dot nuovi partono senza permessi. Nel
  dialog si scelgono i destinatari e se “Ask me before delegating” è attivo
  (default).
- La delega gira in una conversazione inbox dedicata per coppia caller→target
  (`delegation:<caller>:<target>`), con i permessi e le approvazioni del target.
  Profondità 1: il target non può ridelegare. Se il target è occupato la richiesta
  torna `busy`; le approvazioni vengono “claimate” atomicamente (niente doppia
  esecuzione), scadono dopo un'ora e vengono rifiutate se il permesso viene
  revocato.
- Con approvazione richiesta, la chat mostra una card con la richiesta esatta e i
  nomi correnti dei due Dot; nulla parte prima di **Approve**. In voce/task/Slack
  la delega che richiede approvazione risponde “continua nel web”.
- Test: `delegation.test.ts`, `delegation-card.test.tsx`, `dot-delete.test.ts`
  (permessi, depth, busy, approvazione/rifiuto, retry singolo, scadenza, revoca,
  cancellazione con cascata e pulizia archi).

**Migrazioni**

- v4 journal durevole, v5 gestione conversazioni (archivio + indici),
  v6 stato Learning automatico. Test dedicato che aggiorna un database nello
  schema del branch precedente (v1–v3) senza perdere conversazioni o replay.

## 4. Configurazione

```env
# Server
HOST=127.0.0.1
PORT=4310
DATABASE_PATH=data/opendots.sqlite
OWNER_ID=opendots-owner

# Modello (DeepSeek / Ollama / OpenAI-compatible)
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=...
AI_MODEL=deepseek-chat
# AI_MAX_OUTPUT_TOKENS=2200
# AGENT_RUN_TIMEOUT_MS=90000

# Learning locale (opzionale)
# LEARNING_EVIDENCE_LIMIT=2000

# Slack diretto (opzionale)
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_CHANNEL_NAME=
SLACK_TEAM_ID=
SLACK_USER_IDS=
# SLACK_DOT_ID=
```

`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` restano supportati come
fallback. Accesso LAN: `HOST=0.0.0.0` + `OWNER_TOKEN` (≥24 caratteri) +
`APP_ORIGIN`.

---

## 5. Automatic Learning in pratica

1. Nel dialog del Dot, **Automatic Learning**: inserisci un ID container nuovo
   (es. `research-workflow`) e salva. Il container viene creato in locale.
2. Le nuove conversazioni (chat, pagina, voce, task, Slack) registrano evidence.
3. **Review evidence and skills** → **Analyze evidence**: il modello propone
   fino a 3 skill in bozza. Non viene pubblicato nulla automaticamente.
4. Rivedi, **Publish** o **Reject**. Con **Use published skills** attivo, i turni
   successivi ricevono catalogo e tool.
5. Container mancante = turno fallito con errore chiaro (come l'originale).
6. L'analisi è **manuale** (niente schedule automatico) per controllo costi:
   documentato come differenza.

Dettagli: `docs/LEARNING.md`.

---

## 6. Slack in pratica

1. App Slack con Socket Mode, bot token (`xoxb-`) e app token (`xapp-`).
2. Scope: `app_mentions:read`, `chat:write`, `channels:history`,
   `groups:history`, `channels:read`.
3. Eventi: `app_mention` e `message`.
4. Imposta le variabili `SLACK_*`, invita il bot nel canale, riavvia.
5. Stato visibile in **Settings** (not_configured / setup_required / starting /
   online / activation_failed).

Dettagli: `docs/SLACK.md`.

---

## 7. Database

Un solo file (`DATABASE_PATH`):

- Tabelle originali invariate.
- Nuove: `agent_threads`, `agent_runs`, `learning_containers`,
  `learning_evidence`, `learning_skills`, `learning_runs`,
  `slack_subscriptions`, `schema_migrations`.
- Migrazioni versionate e transazionali; `dots.model` aggiunto in modo
  idempotente.

Backup: copia `opendots.sqlite` + `-wal` + `-shm`. Dettagli: `docs/DATABASE.md`.

---

## 8. Test e verifiche eseguite

- `npx tsc --noEmit`: pulito.
- `npx eslint src tests`: pulito.
- `prettier --check`: pulito.
- `vitest run`: **66 file, 382 test passati**.
- `npm run build`: ok.
- Smoke test sul build di produzione:
  - streaming SSE, tool call reale (`list_authorized_spaces`), trascrizione
    persistita;
  - creazione container, evidence, analyze (fake model), publish, delivery
    (catalogo + tool nel request successivo);
  - persistenza dopo restart;
  - `/api/learning/containers` e `/api/state` rispondono;
  - rifiuto avvio su `HOST=0.0.0.0` senza `OWNER_TOKEN`.

Nessuna chiamata live a DeepSeek/Ollama/OpenBot/Slack/Parallel/Composio/voce:
come richiesto, le integrazioni reali ci sono ma la validazione live è rinviata.
I test usano un finto server OpenAI-compatible e un client Slack finto.

---

## 9. Limiti noti (documentati)

1. **Learning**: l'analisi automatica è opzionale, disattivata di default e
   limitata da readiness, nuova evidence e intervallo; non pubblica mai da sola.
   Non esiste un cron per container né uno scheduler cloud.
2. **Route PATCH/DELETE native del runtime** restano solo Intelligence: la
   gestione (rename/archive/delete/paginazione/ricerca) è implementata da OpenDots
   via API proprietarie `/api/conversations`.
3. **Approvazioni solo in web chat** (come upstream): in Slack/task il Dot chiede
   di continuare nell'app.
4. **Durabilità = tracciamento stato**, non exactly-once: run interrotti vanno
   in **Interrupted** e richiedono retry esplicito.
5. **Nessuna memoria semantica** (non c'era nemmeno upstream): memoria owner
   esplicita nel prompt.
6. **Validazione live rinviata** per tutti i provider esterni.
7. In caso di crash si può perdere al massimo l'ultimo batch non flushato
   (≤64 eventi o 250 ms). Gli eventi già committati restano, il run viene marcato
   `interrupted` e nessuna azione viene ripetuta automaticamente.
8. **Non è exactly-once**: la durabilità traccia lo stato e conserva gli eventi,
   ma un effetto esterno può essere avvenuto senza esito finale registrato; per
   questo i run interrotti richiedono revisione umana.

Dettagli: `docs/FEATURE_PARITY.md` e `docs/MASTRA_MIGRATION.md` del branch Mastra
(solo riferimento storico).

---

## 10. Git

```bash
git log --oneline origin/main..HEAD
git push -u origin feature/opendots-local-intelligence
```

- Nessun commit su `main`, nessun merge automatico, nessun force push.
- `feature/mastra-self-hosted` intatto.
- Nessun secret, `.env`, database o `node_modules` committato.

---

## 11. Prossimi passi suggeriti

1. Provare DeepSeek e Ollama reali (una conversazione, una pagina, un restart).
2. Validare OpenBot (browser/file/shell) e voce con i tuoi servizi.
3. Creare l'app Slack e provare menzione + follow-up in thread.
4. Fare 2–3 conversazioni sullo stesso container, analizzare, rivedere e
   pubblicare una skill; verificare che il turno successivo la carichi.
5. Se vuoi l'analisi automatica: aggiungere un timer che chiama
   `LearningService.analyze` rispettando pausa e threshold.
6. Se vuoi rename/archive/delete thread: implementare route locali equivalenti.
7. Aprire la PR di merge su `main` del fork quando sei soddisfatto.

---

## 12. Documenti

- `docs/FEATURE_PARITY.md` — matrice completa upstream → locale.
- `docs/ARCHITECTURE_DECISIONS.md` — ADR (perché TanStack resta, runtime SSE,
  SQLite, Learning, Slack, telemetria).
- `docs/LEARNING.md` — workflow Learning locale.
- `docs/SLACK.md` — setup Slack diretto.
- `docs/DATABASE.md` — schema, journal durevole, gestione conversazioni,
  Learning automatico, migrazioni, backup e recovery.
- `docs/LICENSE_AUDIT.md` — licenze e costi.
- `docs/SETUP.md` — setup self-hosted completo.
- `docs/DELEGATION.md` — regole e flusso della delega tra Dot.
