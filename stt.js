//Mit WebsocketServer verbinden
const port = parseInt(process.argv[2]);
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:' + port);

//Libs
const { exec } = require('child_process');
const fs = require('fs-extra');
const FileWriter = require('wav').FileWriter;
const mic = require('mic');
const MiniSearch = require('minisearch');
const http = require('http');
const Gpio = require('onoff').Gpio;
const player = require('node-wav-player');

//Mikroaufnahme
var micInstance;
var micInputStream;
var outputFileStream;

//AudioDir holen fuer Erstellung des Playlist-Aufrufs ueber lastSession.json
const audioDir = fs.readJSONSync(__dirname + "/../AudioServer/config.json").audioDir + "/wap/mp3";

//Button und LED
const button = new Gpio(6, 'in', 'falling', { debounceTimeout: 100 });
const led = new Gpio(26, 'out');
var ledHeartbeatInterval;

//Lock-Flag, damit Button nicht mehrfach gleichzeitig gedrueckt werden kann
var buttonLock = false;

//vosk-api sst command
const voskSTTcommand = "cd " + __dirname + "/../vosk-api/python/example && python3 stt-mh.py " + __dirname + "/stt.wav";

//ggf. Stopwoerter bei Indexsuche ingorieren
//let stopWords = new Set(['und', 'der', 'die', 'das']);
const stopWords = new Set([]);

//Wenn Verbindung mit WSS hergestellt wird
ws.on('open', function open() {
    console.log("connected to wss from stt search");

    //Wenn Button gedrueckt wird -> Aufnahme starten
    button.watch(function () {

        //Wenn gerade schon eine STT Berechnung laueft -> abbrechen
        if (buttonLock) {
            console.log("button pressed -> lock active. please wait");
            return;
        }

        //Lock setzen
        console.log("button pressed -> set lock, play beep, pause player, led on, mic on");
        buttonLock = true;

        //Start Beep
        player.play({ path: __dirname + '/beep-start.wav' });

        //Audio Player pausieren (falls er gerade laueft), damit man Mikro besser hoert
        ws.send(JSON.stringify({
            type: "pause-if-playing",
            value: false
        }));

        //LED an
        led.write(1);

        //Mikroaufnahme: channel 1 = mono
        micInstance = mic({
            rate: 48000,
            channels: 1,
            device: "hw:2,0",
            debug: false,
            exitOnSilence: 10
        });
        micInputStream = micInstance.getAudioStream();
        outputFileStream = new FileWriter(__dirname + '/stt.wav', {
            sampleRate: 48000,
            channels: 1
        });
        micInputStream.pipe(outputFileStream);

        //Bei Stille Aufnahme stoppen
        micInputStream.on('silence', function () {
            console.log("Got SIGNAL silence -> stop mic, play calculating, led heartbeat, stt calculating");
            micInstance.stop();

            //Beep + Calculating Sound
            player.play({ path: __dirname + '/kalimba.wav' });

            //LED Heartbeat
            ledHeartbeatInterval = setInterval(_ => led.writeSync(led.readSync() ^ 1), 200);

            //vosk STT-Analyse der aufgenommenen wav-Datei
            exec(voskSTTcommand, (err, searchTerm, stderr) => {
                console.log("vosk-api stt: " + searchTerm);

                //Suchindex aus vorher erstellter JSON-Datei anlegen fuer Suche nach Playlist
                fs.readJSON(__dirname + '/sttIndex.json').then(jsonData => {
                    const miniSearch = new MiniSearch({
                        //fileds to index
                        fields: ['name', 'tracks'],
                        //fields to return with search results
                        storeFields: ['name', 'topMode', 'mode', 'allowRandom'],
                        //Stopwords fuer Indexierung und Suche entfernen
                        processTerm: (term, _fieldName) => stopWords.has(term) ? null : term.toLowerCase(),
                        //Name der Playlist staerker gewichten
                        searchOptions: {
                            boost: { name: 5 }
                        }
                    });

                    //TODO: remove
                    //searchTerm = "benjamin verliebt"

                    //Index anlegen und Prefix-Suche starten
                    miniSearch.addAll(jsonData);
                    const results = miniSearch.search(searchTerm, {
                        prefix: true
                    });

                    //Calculation Sound stoppen
                    player.stop();

                    //stop heartbeat led und led off
                    clearInterval(ledHeartbeatInterval);
                    led.writeSync(0);

                    //Wenn es Treffer gibt
                    if (results.length) {
                        item = results[0];
                        console.log(item);

                        //Clever: lastSession-Datei anlegen, die beim Start des AudioServers geladen wird
                        fs.writeJson(__dirname + "/../AudioServer/lastSession.json", {
                            path: audioDir + "/" + item.topMode + "/" + item.mode + "/" + item.id,
                            activeItem: item.mode + "/" + item.id,
                            activeItemName: item.name,
                            allowRandom: item.allowRandom,
                            position: 0
                        }).then(() => {
                            console.log("play pico2wave tts file")

                            //"Max - 11 - Lernt Rad fahren" -> "Max Lernt Rad fahren" 
                            const titleToRead = item.name.replace(/ \- \d+ \-/, "");

                            //Sprachausgabe fuer ausgewaehlte Playlist und dann Playlist starten
                            const pico2waveTTScommand = `
                                pico2wave -l de-DE -w ${__dirname}/tts.wav "${titleToRead}" &&
                                ffmpeg -i ${__dirname}/tts.wav -af acompressor=threshold=-11dB:ratio=9:attack=200:release=1000:makeup=2 ${__dirname}/tts-comp.wav &&
                                aplay ${__dirname}/tts-comp.wav &&
                                rm ${__dirname}/tts.wav &&
                                rm ${__dirname}/tts-comp.wav`;
                            exec(pico2waveTTScommand, (err, data, stderr) => {
                                http.get("http://localhost/php/activateAudioApp.php?mode=audio");
                            });
                        });
                    }

                    //Wenn keine Treffer gefunden wurden, Player wieder starten und Lock zuruecksetzen
                    else {
                        console.log("no results for stt");
                        resumePlaying();
                    }
                });
            });
        });

        //Aufnahme starten
        micInstance.start();
    });
});

//Kein Playliststart durch STT moeglich -> bisherige Playlist fortfuehren
function resumePlaying() {
    console.log("release lock, play error beep, resume playing");

    //Lock zuruecksetzen, damit Button wieder gedrueckt werden kann
    buttonLock = false;

    //Error Beep 
    player.play({ path: __dirname + '/beep-error.wav' });

    //Nachricht an WSS schicken: Playlist wieder fortfuehren
    ws.send(JSON.stringify({
        type: "toggle-paused",
        value: false
    }));
}