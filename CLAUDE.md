# Job Hunt Pipeline — e:\ProyectosVS\trabajo

## At the start of EACH session

Load the pipeline skill before doing anything:

```
/job-hunt-pipeline
```

This skill contains everything: sources, scoring, embeddings, job states, application recipes (getonbrd/Ashby/torre), compensation rules and candidate constraints.

## Docker DB

Verify the container is up before using the pipeline:
```bash
docker ps --filter "name=jobhunt"
# Port 5433. If down: docker compose up -d
```

## Master runner

```bash
node --env-file=.env sources/run-all.mjs          # everything
node --env-file=.env sources/run-all.mjs --skip-linkedin  # fast (no LinkedIn)
node --env-file=.env scoring/score.mjs            # new jobs only
node --env-file=.env scoring/embed.mjs            # unembedded only
node --env-file=.env scoring/score.mjs --rescore  # re-score all (after updating learned.json)
```

## Dashboard

```bash
node review/server.mjs   # → http://localhost:5173
```
