const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

function canon(o) {
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
  if (o && typeof o === 'object') {
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}

/* ---------- Fusion des données de plusieurs téléphones ---------- */
/* Chaque rendez-vous et chaque prestation porte une date de dernière modification (maj).
   Les suppressions sont notées dans "supprimes". La version la plus récente gagne,
   et rien n'est perdu quand plusieurs personnes saisissent en même temps. */
function fusionner(a, b) {
  a = a || {};
  b = b || {};
  const sup = {};
  [a.supprimes, b.supprimes].forEach((s) => {
    Object.keys(s || {}).forEach((k) => {
      sup[k] = Math.max(sup[k] || 0, s[k] || 0);
    });
  });
  function liste(cle) {
    const m = {};
    [a[cle], b[cle]].forEach((l) => {
      (l || []).forEach((x) => {
        if (!x || !x.id) return;
        const v = x.maj || 0;
        if (sup[x.id] && sup[x.id] >= v) return;
        const deja = m[x.id];
        if (!deja || (deja.maj || 0) < v || ((deja.maj || 0) === v && canon(x) > canon(deja))) m[x.id] = x;
      });
    });
    return Object.keys(m)
      .sort()
      .map((id) => m[id]);
  }
  const ra = a.reglagesMaj || 0;
  const rb = b.reglagesMaj || 0;
  const A = a.reglages || b.reglages;
  const B = b.reglages || a.reglages;
  const reglages = (rb > ra ? B : ra > rb ? A : canon(A) <= canon(B) ? A : B) || { nom: 'Woman Dream', devise: 'FCFA' };
  return {
    reglages,
    reglagesMaj: Math.max(ra, rb),
    prestations: liste('prestations'),
    rdv: liste('rdv'),
    supprimes: sup,
    maj: Math.max(a.maj || 0, b.maj || 0),
    derniereSauvegarde: b.derniereSauvegarde || a.derniereSauvegarde || null,
  };
}

/* ---------- Code d'accès ---------- */
function hacher(code, sel) {
  return crypto.scryptSync(code, sel, 32).toString('hex');
}
function egal(x, y) {
  const bx = Buffer.from(String(x));
  const by = Buffer.from(String(y));
  return bx.length === by.length && crypto.timingSafeEqual(bx, by);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let pret = false;
async function preparer(sql) {
  if (pret) return;
  await sql`CREATE TABLE IF NOT EXISTS womandream (
    id INT PRIMARY KEY,
    contenu JSONB NOT NULL,
    maj TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE womandream ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0`;
  pret = true;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const base = process.env.DATABASE_URL;
  if (!base) {
    res.status(503).json({ erreur: 'Base de données non connectée' });
    return;
  }
  const sql = neon(base);

  try {
    await preparer(sql);

    const lignes = await sql`SELECT id, contenu, version FROM womandream WHERE id IN (1, 2)`;
    const donnees = lignes.find((l) => l.id === 1) || null;
    const config = lignes.find((l) => l.id === 2) || null;
    const codeEnv = process.env.CODE_ACCES || '';
    const codeExiste = !!(codeEnv || config);

    let fourni = '';
    try {
      fourni = decodeURIComponent(req.headers['x-code'] || '');
    } catch (e) {
      fourni = '';
    }

    /* Création du code d'accès (une seule fois, tant qu'aucun code n'existe) */
    if (req.method === 'POST') {
      const corps = req.body || {};
      if (corps.action !== 'creer') {
        res.status(400).json({ erreur: 'Requête invalide' });
        return;
      }
      if (codeExiste) {
        res.status(403).json({ erreur: 'Un code existe déjà' });
        return;
      }
      const nouveau = String(corps.code || '');
      if (nouveau.length < 6) {
        res.status(400).json({ erreur: 'Code trop court' });
        return;
      }
      const sel = crypto.randomBytes(16).toString('hex');
      const cree = await sql`INSERT INTO womandream (id, contenu, version)
        VALUES (2, ${JSON.stringify({ sel, hash: hacher(nouveau, sel) })}::jsonb, 1)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      if (!cree.length) {
        res.status(403).json({ erreur: 'Un code existe déjà' });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (!codeExiste) {
      res.status(200).json({ besoin: 'creation' });
      return;
    }

    const valide = codeEnv ? egal(fourni, codeEnv) : egal(hacher(fourni, config.contenu.sel), config.contenu.hash);
    if (!valide) {
      if (fourni) await pause(600); // petit délai seulement si un mauvais code a été saisi
      res.status(401).json({ erreur: 'Code incorrect' });
      return;
    }
     if (req.method === 'PATCH') {
      if (codeEnv) {
        res.status(409).json({ erreur: 'Le code est défini dans Vercel' });
        return;
      }
      const nouveau = String((req.body && req.body.nouveau) || '');
      if (nouveau.length < 6) {
        res.status(400).json({ erreur: 'Code trop court' });
        return;
      }
      const sel = crypto.randomBytes(16).toString('hex');
      await sql`UPDATE womandream
        SET contenu = ${JSON.stringify({ sel, hash: hacher(nouveau, sel) })}::jsonb, version = version + 1, maj = now()
        WHERE id = 2`;
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'GET') {
      res.status(200).json({ contenu: donnees ? donnees.contenu : null });
      return;
    }

    if (req.method === 'PUT') {
      const c = req.body && req.body.contenu;
      if (!c || !Array.isArray(c.rdv) || !Array.isArray(c.prestations) || !c.reglages) {
        res.status(400).json({ erreur: 'Données invalides' });
        return;
      }
      /* On relit, on fusionne, puis on enregistre seulement si personne n'a écrit entre-temps. */
      for (let essai = 0; essai < 4; essai++) {
        const actuel = (await sql`SELECT contenu, version FROM womandream WHERE id = 1`)[0] || null;
        const fusion = fusionner(actuel ? actuel.contenu : null, c);
        const texte = JSON.stringify(fusion);
        let ecrit;
        if (!actuel) {
          ecrit = await sql`INSERT INTO womandream (id, contenu, version)
            VALUES (1, ${texte}::jsonb, 1)
            ON CONFLICT (id) DO NOTHING
            RETURNING version`;
        } else {
          ecrit = await sql`UPDATE womandream
            SET contenu = ${texte}::jsonb, version = version + 1, maj = now()
            WHERE id = 1 AND version = ${actuel.version}
            RETURNING version`;
        }
        if (ecrit.length) {
          res.status(200).json({ contenu: fusion });
          return;
        }
      }
      res.status(409).json({ erreur: 'Réessayez dans un instant' });
      return;
    }

    res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (e) {
    res.status(500).json({ erreur: 'Erreur du serveur' });
  }
};

module.exports.fusionner = fusionner;