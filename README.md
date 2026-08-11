# 🌘 Eclipse Scout

Estensione Chrome che sovrappone a **Google Maps / Street View** la posizione e la traiettoria di sole e luna a un orario scelto. Nata per scegliere il punto di osservazione dell'**eclissi totale del 12 agosto 2026** in Spagna: a Zaragoza la totalità è alle **20:29 CEST** con il sole a soli **~6° sopra l'orizzonte** (azimut ~285°, ovest-nord-ovest) — un palazzo o un filare di alberi bastano a coprirla. Con questa estensione apri Street View in un punto candidato e vedi subito se il sole a quell'ora è libero o dietro un ostacolo.

## Installazione (2 minuti)

1. Apri Chrome → `chrome://extensions`
2. Attiva **Modalità sviluppatore** (toggle in alto a destra)
3. **Carica estensione non pacchettizzata** → seleziona questa cartella (`~/Nexus/progetti/eclipse-scout`)
4. Apri [Google Maps](https://www.google.com/maps), entra in Street View dove vuoi: appare il pannello "Eclipse Scout" in alto a destra

## Uso

- **In Street View**: disco del sole in scala reale (nero con alone rosso durante la totalità, arancione in parziale), disco della luna sovrapposto, traiettoria del sole nel giorno scelto con tick orari, linea tratteggiata dell'orizzonte astronomico (alt 0°).
- **Fasi locali automatiche**: per il punto che stai guardando l'estensione calcola gli orari veri dell'eclissi (`SearchLocalSolarEclipse`). I preset mostrano Parziale/TOTALITÀ/Fine con gli orari del punto, e un banner ti dice se sei **dentro la fascia di totalità** o se lì l'eclissi è solo parziale (con % di copertura).
- **Calibrazione**: se l'overlay non è allineato al panorama (succede con fov/heading imprecisi dell'URL), tieni premuto **⌥ (Alt) e trascina** per allineare orizzonte e direzione; **⌥+doppio clic** per azzerare. L'offset resta salvato.
- Readout: azimut/altezza di sole e luna, separazione angolare, % di copertura del sole.
- Se il sole è fuori dall'inquadratura compare una freccia "Sole a destra/sinistra (N°)".
- **In mappa**: raggio dal centro verso l'azimut di sole (pieno) e luna (tratteggiato).

**Workflow consigliato**: apri Street View nel punto candidato → preset TOTALITÀ → guarda dove cade il disco → se serve allinea con ⌥+trascina → se c'è un ostacolo davanti al disco, cambia punto. A 6° di altezza un ostacolo alto 10 m copre il sole già a ~95 m di distanza.

## Come funziona

- Legge lat/lng, heading, tilt e fov direttamente dall'**URL** di Google Maps (`@lat,lng,3a,75y,287h,90t`) — niente API key, niente costi. Il valore `y` è il **fov verticale** del riquadro (determinato empiricamente: 75.1° misurato con two-view solve su screenshot reali).
- Astronomia con [astronomy-engine](https://github.com/cosinekitty/astronomy) (Don Cross, MIT): posizioni **topocentriche** con rifrazione, precisione ~1 primo d'arco. Verificato sul massimo dell'eclissi a Zaragoza: separazione sole–luna 0.005° (sovrapposti), orari locali coincidenti con timeanddate a ~10 s.
- Copertura del sole calcolata geometricamente (area di intersezione dei due dischi).
- Proiezione rettilinea az/alt → pixel; test harness in `test-harness.html` (aprilo da un server locale per provare l'overlay senza Google Maps).

## Limiti noti

- **Rotazione orizzontale**: l'overlay segue in tempo reale leggendo la bussola di Street View (quella in basso a destra). Se la bussola non è agganciabile (markup cambiato/assente), si torna al comportamento "aggiorna a fine gesto" e il pannello lo segnala.
- **Drag verticale e zoom**: pitch e fov arrivano solo dall'URL a fine gesto → durante questi gesti l'overlay si nasconde e ricompare appena la vista si assesta.
- Il fov dell'URL è approssimato → l'allineamento può richiedere il ⌥+trascina, soprattutto nelle photosphere degli utenti (heading a volte impreciso). Sul Street View "ufficiale" (linee blu) è più affidabile.
- La "Fine" mostrata può essere dopo il tramonto (fine geometrica): in quel caso il disco è già sotto la linea d'orizzonte, come da realtà.
- Data/ora interpretate nel fuso del computer (Italia = Spagna, quindi ok).

## Roadmap possibile

- Simulazione visiva della falce (sagoma della luna che morde il disco solare in parziale).
- Versione web app con Maps JavaScript API: POV in tempo reale mentre trascini (richiede API key Google Cloud).
- Correzione fov automatica stimata dal confronto tra due viste.
