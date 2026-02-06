const { createApp } = require('./app');

const app = createApp();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(port, () => console.log(`dashmon app listening on ${port}`));
