# Privát Walkie-Talkie (2 felhasználó)

Magyar nyelvű, mobilon és asztali böngészőben működő, jelszóval védett **push-to-talk** MVP. A hang WebRTC-n keresztül jut el a másik résztvevőhöz, az alkalmazásszerver pedig a WebSocket-jelzést és a beszédjogot kezeli.

## Funkciók

- Egyszerű jelszavas belépőoldal (jelszó ellenőrzése a szerveren).
- Legfeljebb **két aktív WebSocket-kapcsolat** ugyanabban a privát szobában.
- Nyomva tartott beszédgomb, szerveroldalon koordinált beszédjog.
- Alapvető sikertelen belépés elleni korlátozás, HttpOnly munkamenet-cookie, Origin-ellenőrzés.
- WebRTC hangátvitel, alapértelmezett STUN-kiszolgáló és opcionális TURN-konfiguráció.
- Külső NPM-csomag nélkül futó Node.js szerver.

## Lokális indítás

Node.js **20.12+** szükséges.

1. Klónozd a repositoryt.
2. Másold a `.env.example` fájlt `.env` néven.
3. Állítsd be az `APP_PASSWORD` értékét egy saját, **legalább 12 karakteres** jelszóra.
4. Indítsd el az alkalmazást:

```bash
npm start
```

Ezután a böngészőben nyisd meg: http://localhost:3000

**Fontos:** `.env` és az éles jelszó soha ne kerüljön GitHubra. A mintajelszó nem használható éles környezetben.

## Tesztelés

```bash
npm test
```

A teszt ellenőrzi a HTTP-kiszolgálást, bejelentkezést, sessiont, beszédjogot, a harmadik résztvevő elutasítását és a kilépést. A valódi mikrofonos kapcsolatot két külön eszközzel manuálisan is tesztelni kell.

## Render telepítés (Free)

1. Render Dashboard → **New Web Service** → csatlakoztasd ezt a GitHub-repositoryt.
2. Runtime: Node, branch: `main`, start command: `npm start`.
3. Environment:
   - `APP_PASSWORD` = saját hosszú és egyedi közös jelszó.
   - `COOKIE_SECURE` = `true`.
   - Opcionálisan `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
4. Telepítés után nyisd meg a Render által adott `https://...` címet mindkét eszközön.

A mikrofonhoz HTTPS vagy localhost szükséges. A Render ingyenes példánya inaktivitás után elalhat, így nem garantált a folyamatos azonnali elérés. A WebRTC közvetlen kapcsolata mobilhálózaton TURN nélkül meghiúsulhat.

## Architektúra

```text
Telefon A / böngésző                 Telefon B / böngésző
           \                           /
            \  WebRTC audio (P2P/TURN) /
             \_______________________/
                     |
          Node.js HTTP + WebSocket
         - jelszavas bejelentkezés
         - session / max. 2 résztvevő
         - WebRTC SDP/ICE jelzés
         - push-to-talk beszédjog
```

- `server.js`: HTTP API, hitelesítés, session és WebSocket jelzés.
- `ws-lite.js`: minimális, szöveges WebSocket implementáció.
- `public/index.html`: bejelentkezés és szoba.
- `public/app.js`: WebRTC, mikrofon és PTT-logika.
- `public/style.css`: reszponzív felület.
- `test/integration.test.js`: integrációs teszt.

## Biztonsági és MVP-korlátok

- A kétfős korlát **kapcsolatokra** vonatkozik, nem külön személyazonosságra: a közös jelszót ismerő bárki elfoglalhatja az egyik helyet.
- A munkamenetek és az aktuális szobaállapot memóriában vannak; szerver-újraindítás után elvesznek. Egyetlen futó szerverpéldányt használj.
- A jelszót szerveroldalon ellenőrzi az alkalmazás; állíts be titkosított HTTPS-t és erős jelszót.
- Éles, mobilhálózaton stabil használathoz TURN-szerver ajánlott.
- Mobilböngészőkben a háttérbe helyezés és az automatikus hangindítás korlátozott lehet.
- A WebRTC maga titkosított médiát használ, de ez a mintaprojekt **nem implementál külön, alkalmazásszintű E2EE protokollt**.
