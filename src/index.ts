import { app } from "./app.js";
import { env } from "./env.js";

app.listen(env.PORT, () => {
  console.log(`Blue Ledger API listening on http://localhost:${env.PORT}`);
});
