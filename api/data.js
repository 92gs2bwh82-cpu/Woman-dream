const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const attendu = process.env.CODE_ACCES;
  const base = process.env.DATABASE_URL;
  if (!attendu || !base) {
    res.status(503).json({ erreur: 'Synchronisation non configurée' });
    return;
  }

  let fourni = '';
  try {
    fourni = decodeURIComponent(req.headers['x-code'] || '');
  } catch (e) {
    fourni = '';
  }
  if (fourni !== attendu) {
    res.status(401).json({ erreur: 'Code incorrect' });
    return;
  }

  const sql = neon(base);

  try {
    await sql`CREATE TABLE IF NOT EXISTS womandream (
      id INT PRIMARY KEY,
      contenu JSONB NOT NULL,
      maj TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

    if (req.method === 'GET') {
      const lignes = await sql`SELECT contenu FROM womandream WHERE id = 1`;
      res.status(200).json({ contenu: lignes.length ? lignes[0].contenu : null });
      return;
    }

    if (req.method === 'PUT') {
      const c = req.body && req.body.contenu;
      if (!c || !Array.isArray(c.rdv) || !Array.isArray(c.prestations) || !c.reglages) {
        res.status(400).json({ erreur: 'Données invalides' });
        return;
      }
      await sql`INSERT INTO womandream (id, contenu, maj)
        VALUES (1, ${JSON.stringify(c)}::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET contenu = EXCLUDED.contenu, maj = now()`;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (e) {
    res.status(500).json({ erreur: 'Erreur du serveur' });
  }
};
