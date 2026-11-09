const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const catalogue = require("./catalogue");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10000 });
const crypto = require("crypto");
const avisRecus = [];

app.disable("x-powered-by");
app.use(function (req, res, next) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.get("/admin/avis", function (req, res) {
  const cle = process.env.ADMIN_KEY || "";
  const recu = String(req.query.cle || "");
  const a = Buffer.from(cle), b = Buffer.from(recu);
  const ok = cle.length >= 12 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { return res.status(404).send("Introuvable"); }
  res.setHeader("Cache-Control", "no-store");
  res.json(avisRecus);
});
app.use(express.static("public"));

const BUDGET = 800, DUREE = 20, MAX_EQUIPE = 11;
const MAX_POSTE = { GAR: 1, DEF: 4, MIL: 3, ATT: 3 };
const parties = {};
const attente = { classique: null, aveugle: null };

const minPoste = {};
Object.keys(MAX_POSTE).forEach(function (po) {
  minPoste[po] = Math.min.apply(null, catalogue.filter(function (p) { return p.poste === po; }).map(function (p) { return p.valeur; }));
});

function melanger(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = b[i]; b[i] = b[j]; b[j] = t;
  }
  return b;
}

function peutAcheter(g, i, poste) {
  const n = g.equipes[i].filter(function (p) { return p.poste === poste; }).length;
  return g.equipes[i].length < MAX_EQUIPE && n < MAX_POSTE[poste];
}

function maxMise(g, i, poste) {
  let reserve = 0;
  const reste = g.deck.slice(g.index + 1);
  Object.keys(MAX_POSTE).forEach(function (po) {
    let m = MAX_POSTE[po] - g.equipes[i].filter(function (p) { return p.poste === po; }).length;
    if (po === poste) { m--; }
    if (m > 0) {
      const prix = reste.filter(function (p) { return p.poste === po; })
        .map(function (p) { return p.valeur; })
        .sort(function (x, y) { return x - y; })
        .slice(0, m);
      reserve += prix.reduce(function (t, v) { return t + v; }, 0);
    }
  });
  return g.budgets[i] - reserve;
}

function codeAleatoire() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (parties[c]);
  return c;
}

function creer(mode) {
  const g = { code: codeAleatoire(), joueurs: [], budgets: [BUDGET, BUDGET], equipes: [[], []],
    deck: melanger(catalogue), index: 0, premier: 0, phase: "attente", info: "", reste: DUREE,
    timer: null, mise: 0, meneur: null, tour: 0, dejaPropose: false, resultat: null,
    mode: mode === "aveugle" ? "aveugle" : "classique", offres: [null, null], minOffre: 0, egalites: 0 };
  parties[g.code] = g;
  return g;
}

function vue(g, i) {
  const j = g.phase === "jeu" ? g.deck[g.index] : null;
  const aveugle = g.mode === "aveugle";
  const actif = j && (aveugle ? g.offres[i] === null : g.tour === i);
  return { code: g.code, moi: i, phase: g.phase, mode: g.mode,
    noms: g.joueurs.map(function (p) { return p.nom; }),
    budgets: g.budgets, equipes: g.equipes, carte: j, mise: g.mise, meneur: g.meneur, tour: g.tour, reste: g.reste,
    info: g.info, resultat: g.resultat, minOffre: g.minOffre,
    envoye: g.offres.map(function (o) { return o !== null; }), monOffre: g.offres[i],
    max: actif ? Math.max(0, maxMise(g, i, j.poste)) : null };
}

function diffuser(g) {
  g.joueurs.forEach(function (p, i) { if (p.sid) { io.to(p.sid).emit("etat", vue(g, i)); } });
}

function lancerTimer(g) {
  clearInterval(g.timer);
  g.reste = DUREE;
  g.timer = setInterval(function () {
    g.reste--;
    if (g.reste <= 0) { if (g.mode === "aveugle") { expirer(g); } else { abandonner(g); } } else { diffuser(g); }
  }, 1000);
  diffuser(g);
}

function nouvelleCarte(g) {
  if (g.index >= g.deck.length || (g.equipes[0].length >= MAX_EQUIPE && g.equipes[1].length >= MAX_EQUIPE)) {
    return finir(g);
  }
  const j = g.deck[g.index];
  g.mise = j.valeur; g.meneur = null; g.dejaPropose = false; g.tour = g.premier;
  const ok = function (i) { return peutAcheter(g, i, j.poste) && maxMise(g, i, j.poste) >= j.valeur; };
  if (!ok(0) && !ok(1)) { g.index++; return nouvelleCarte(g); }
  if (g.mode === "aveugle") {
    g.tour = -1; g.egalites = 0; g.minOffre = j.valeur;
    g.offres = [ok(0) ? null : 0, ok(1) ? null : 0];
    return lancerTimer(g);
  }
  if (!ok(g.premier)) { g.tour = 1 - g.premier; }
  lancerTimer(g);
}

function abandonner(g) {
  const j = g.deck[g.index];
  if (g.meneur === null) {
    const autre = 1 - g.tour;
    if (!g.dejaPropose && peutAcheter(g, autre, j.poste) && maxMise(g, autre, j.poste) >= g.mise) {
      g.dejaPropose = true;
      g.info = nom(g, g.tour) + " a refusé : la carte est proposée à l’autre joueur.";
      g.tour = autre;
      return lancerTimer(g);
    }
    g.info = "Carte non vendue.";
  } else {
    g.budgets[g.meneur] -= g.mise;
    g.equipes[g.meneur].push(Object.assign({}, j, { prix: g.mise }));
    g.info = nom(g, g.meneur) + " remporte " + j.nom + " pour " + g.mise + " M€.";
  }
  g.index++;
  g.premier = 1 - g.premier;
  nouvelleCarte(g);
}

function encherir(g, i, montant) {
  if (g.phase !== "jeu" || g.tour !== i) { return "Ce n’est pas ton tour."; }
  const j = g.deck[g.index];
  const min = g.meneur === null ? g.mise : g.mise + 1;
  montant = Number(montant);
  if (!Number.isInteger(montant) || montant < min) { return "L’enchère doit être d’au moins " + min + " M€."; }
  if (!peutAcheter(g, i, j.poste)) { return "Limite atteinte pour ce poste (ou équipe complète)."; }
  if (montant > g.budgets[i]) { return "Budget insuffisant : il te reste " + g.budgets[i] + " M€."; }
  const mx = maxMise(g, i, j.poste);
  if (montant > mx) { return "Garde de quoi compléter ton équipe : enchère max " + Math.max(0, mx) + " M€."; }
  g.mise = montant; g.meneur = i; g.tour = 1 - i; g.info = "";
  if (!peutAcheter(g, g.tour, j.poste) || maxMise(g, g.tour, j.poste) < g.mise + 1) {
    abandonner(g);
  } else {
    lancerTimer(g);
  }
  return null;
}

function nom(g, i) { return g.joueurs[i].nom; }

function nettoyer(n, i) {
  const brut = String(n || "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF<>&"'`]/g, "")
    .replace(/\s+/g, " ").trim();
  const t = Array.from(brut).slice(0, 16).join("").trim();
  return t || "Joueur " + (i + 1);
}

function eligible(g, i, poste, min) {
  return peutAcheter(g, i, poste) && maxMise(g, i, poste) >= min;
}

function offrir(g, i, montant) {
  if (g.phase !== "jeu" || g.mode !== "aveugle") { return "Pas d’offre possible maintenant."; }
  if (g.offres[i] !== null) { return "Ton offre est déjà envoyée."; }
  const j = g.deck[g.index];
  montant = Number(montant);
  if (!Number.isInteger(montant) || montant < g.minOffre) { return "L’offre doit être d’au moins " + g.minOffre + " M€."; }
  if (!peutAcheter(g, i, j.poste)) { return "Limite atteinte pour ce poste (ou équipe complète)."; }
  if (montant > g.budgets[i]) { return "Budget insuffisant : il te reste " + g.budgets[i] + " M€."; }
  const mx = maxMise(g, i, j.poste);
  if (montant > mx) { return "Garde de quoi compléter ton équipe : offre max " + Math.max(0, mx) + " M€."; }
  g.offres[i] = montant;
  verifierOffres(g);
  return null;
}

function passer(g, i) {
  if (g.phase !== "jeu" || g.mode !== "aveugle" || g.offres[i] !== null) { return; }
  g.offres[i] = 0;
  verifierOffres(g);
}

function expirer(g) {
  g.offres = g.offres.map(function (o) { return o === null ? 0 : o; });
  verifierOffres(g);
}

function suivante(g) {
  g.index++;
  g.premier = 1 - g.premier;
  nouvelleCarte(g);
}

function verifierOffres(g) {
  if (g.offres[0] === null || g.offres[1] === null) { return diffuser(g); }
  const a = g.offres[0], b = g.offres[1];
  const j = g.deck[g.index];
  if (a === 0 && b === 0) { g.info = "Personne ne fait d’offre : carte non vendue."; return suivante(g); }
  if (a === b) {
    g.egalites++;
    if (g.egalites >= 3) { g.info = "Égalité répétée à " + a + " M€ : carte non vendue."; return suivante(g); }
    g.minOffre = a + 1;
    g.offres = [eligible(g, 0, j.poste, g.minOffre) ? null : 0, eligible(g, 1, j.poste, g.minOffre) ? null : 0];
    g.info = "Égalité à " + a + " M€ : nouvelle enchère à l’aveugle !";
    if (g.offres[0] === 0 && g.offres[1] === 0) { g.info += " Personne ne peut surenchérir : carte non vendue."; return suivante(g); }
    return lancerTimer(g);
  }
  const gagnant = a > b ? 0 : 1;
  const prix = Math.max(a, b);
  g.budgets[gagnant] -= prix;
  g.equipes[gagnant].push(Object.assign({}, j, { prix: prix }));
  g.info = "Révélation : " + nom(g, 0) + " " + a + " M€ / " + nom(g, 1) + " " + b + " M€ → " + nom(g, gagnant) + " remporte " + j.nom + " !";
  suivante(g);
}

function poisson(l) {
  const lim = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > lim);
  return k - 1;
}

function simulerMatch(g) {
  const eq = [0, 1].map(function (i) {
    const base = g.equipes[i].reduce(function (s, p) { return s + p.note; }, 0) / MAX_EQUIPE;
    const stars = g.equipes[i].filter(function (p) { return p.note >= 89; }).length;
    const malus = stars >= 5;
    const pct = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.floor(Math.random() * 21));
    let force = base;
    if (malus) { force *= 0.85; }
    force *= 1 + pct / 100;
    return { base: base, stars: stars, malus: malus, pct: pct, force: force };
  });
  const moy = (eq[0].force + eq[1].force) / 2;
  const buts = eq.map(function (e) { return poisson(1.4 * Math.pow(moy > 0 ? e.force / moy : 1, 3)); });
  const tirs = buts[0] === buts[1];
  const vainqueur = tirs ? (Math.random() < 0.5 ? 0 : 1) : (buts[0] > buts[1] ? 0 : 1);
  return { eq: eq, buts: buts, tirs: tirs, vainqueur: vainqueur };
}

function finir(g) {
  clearInterval(g.timer);
  g.phase = "fin";
  g.resultat = simulerMatch(g);
  diffuser(g);
  setTimeout(function () { delete parties[g.code]; }, 600000);
}

function ajouter(g, socket, jeton, nomChoisi) {
  const i = g.joueurs.length;
  g.joueurs.push({ jeton: jeton, sid: socket.id, forfait: null, nom: nettoyer(nomChoisi, i) });
  if (i === 1 && g.joueurs[0].nom.toLowerCase() === g.joueurs[1].nom.toLowerCase()) {
    g.joueurs[1].nom = Array.from(g.joueurs[1].nom).slice(0, 12).join("") + " (2)";
  }
  socket.join(g.code);
  socket.data = { code: g.code, i: i };
  if (g.joueurs.length === 2) { g.phase = "jeu"; nouvelleCarte(g); }
  diffuser(g);
}

io.on("connection", function (socket) {
  let compteur = 0;
  const raz = setInterval(function () { compteur = 0; }, 10000);
  socket.use(function (paquet, next) {
    compteur++;
    if (compteur > 150) { return next(new Error("Trop de requêtes")); }
    next();
  });
  socket.on("disconnect", function () { clearInterval(raz); });

  socket.on("creer", function (d) {
    if (socket.data && socket.data.code) { return; }
    if (Object.keys(parties).length >= 300) { return socket.emit("erreur", "Serveur complet, réessaie plus tard."); }
    ajouter(creer(d.mode), socket, d.jeton, d.nom);
  });

  socket.on("rejoindre", function (d) {
    if (socket.data && socket.data.code) { return; }
    const g = parties[String(d.code || "").toUpperCase()];
    if (!g || g.phase !== "attente" || g.joueurs.length !== 1) {
      return socket.emit("erreur", "Code invalide ou partie déjà complète.");
    }
    ajouter(g, socket, d.jeton, d.nom);
  });

  socket.on("rapide", function (d) {
    if (socket.data && socket.data.code) { return; }
    const mode = d.mode === "aveugle" ? "aveugle" : "classique";
    const g = attente[mode] && parties[attente[mode]];
    if (g && g.phase === "attente" && g.joueurs.length === 1) {
      attente[mode] = null;
      ajouter(g, socket, d.jeton, d.nom);
    } else {
      if (Object.keys(parties).length >= 300) { return socket.emit("erreur", "Serveur complet, réessaie plus tard."); }
      const n = creer(mode);
      attente[mode] = n.code;
      ajouter(n, socket, d.jeton, d.nom);
    }
  });

  socket.on("reprendre", function (d) {
    const g = parties[d.code];
    const i = g ? g.joueurs.findIndex(function (p) { return p.jeton === d.jeton; }) : -1;
    if (i < 0) { return socket.emit("perdu"); }
    clearTimeout(g.joueurs[i].forfait);
    g.joueurs[i].sid = socket.id;
    socket.join(g.code);
    socket.data = { code: g.code, i: i };
    diffuser(g);
  });

  socket.on("encherir", function (d) {
    const s = socket.data || {};
    const g = parties[s.code];
    if (!g) { return; }
    const e = encherir(g, s.i, d.montant);
    if (e) { socket.emit("erreur", e); }
  });

  socket.on("abandonner", function () {
    const s = socket.data || {};
    const g = parties[s.code];
    if (g && g.phase === "jeu" && g.tour === s.i) { abandonner(g); }
  });

  socket.on("offre", function (d) {
    const s = socket.data || {};
    const g = parties[s.code];
    if (!g) { return; }
    const e = offrir(g, s.i, d.montant);
    if (e) { socket.emit("erreur", e); }
  });

  socket.on("passer", function () {
    const s = socket.data || {};
    const g = parties[s.code];
    if (g) { passer(g, s.i); }
  });

  socket.on("pseudo", function (d) {
    const s = socket.data || {};
    const g = parties[s.code];
    if (!g) { return; }
    g.joueurs[s.i].nom = nettoyer(d.nom, s.i);
    const autre = g.joueurs[1 - s.i];
    if (autre && autre.nom.toLowerCase() === g.joueurs[s.i].nom.toLowerCase()) {
      g.joueurs[s.i].nom = Array.from(g.joueurs[s.i].nom).slice(0, 12).join("") + " (2)";
    }
    diffuser(g);
  });

  socket.on("avis", function (d) {
    const s = socket.data || {};
    const g = parties[s.code];
    if (!g || g.phase !== "fin" || g.joueurs[s.i].avis) { return; }
    const note = Number(d && d.note);
    if (!Number.isInteger(note) || note < 1 || note > 5) { return; }
    const texte = Array.from(String((d && d.texte) || "").replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")).slice(0, 500).join("").trim();
    g.joueurs[s.i].avis = true;
    const entree = { date: new Date().toISOString(), note: note, texte: texte, mode: g.mode };
    avisRecus.push(entree);
    if (avisRecus.length > 500) { avisRecus.shift(); }
    console.log("AVIS " + JSON.stringify(entree));
    socket.emit("avis-ok");
  });

  socket.on("disconnect", function () {
    const s = socket.data || {};
    const g = parties[s.code];
    if (!g || g.joueurs[s.i].sid !== socket.id) { return; }
    g.joueurs[s.i].sid = null;
    if (g.phase === "attente") {
      delete parties[g.code];
      if (attente[g.mode] === g.code) { attente[g.mode] = null; }
    } else if (g.phase === "jeu") {
      g.joueurs[s.i].forfait = setTimeout(function () {
        if (g.phase === "jeu") {
          clearInterval(g.timer);
          g.phase = "fin";
          g.resultat = { forfait: s.i };
          diffuser(g);
        }
      }, 60000);
    }
  });
});

server.listen(process.env.PORT || 3000, function () {
  console.log("Serveur prêt : http://localhost:" + (process.env.PORT || 3000));
});
