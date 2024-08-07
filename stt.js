const port = parseInt(process.argv[2]);
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:' + port);
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const FileWriter = require('wav').FileWriter;
const mic = require('mic');
const MiniSearch = require('minisearch');
const http = require('http');
const Gpio = require('onoff').Gpio;
const singleSoundPlayer = require('node-wav-player');

//Mikroaufnahme
var micInstance;
var micInputStream;
var outputFileStream;

//AudioDir holen fuer Erstellung des Playlist-Aufrufs ueber lastSession.json
const configFile = fs.readJSONSync(__dirname + "/../AudioServer/config.json");
const audioDir = configFile.audioDir;
const audioFilesDir = audioDir + "/wap/mp3";

//Button und LED
const button = new Gpio(6, 'in', 'falling', { debounceTimeout: 100 });
const led = new Gpio(26, 'out');
var ledHeartbeatInterval;

//Lock-Flag, damit Button nicht mehrfach gleichzeitig gedrueckt werden kann
var buttonLock = false;

//vosk-api sst command
const voskSTTcommand = "cd " + __dirname + "/../vosk-api/python/example && python3 stt-mh.py " + __dirname + "/stt.wav";

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

        console.log("button pressed -> set lock, play beep, pause player, led on, mic on");
        buttonLock = true;
        playSound("stt-start");
        led.write(1);

        //Audio Player pausieren (falls er gerade laueft), damit man Mikro besser hoert
        ws.send(JSON.stringify({
            type: "pause-if-playing",
            value: false
        }));

        //Mikroaufnahme: channel 1 = mono
        micInstance = mic({
            rate: 48000,
            channels: 1,
            device: configFile.STTDevice,
            debug: false,
            //TODO: groesserer Wert?
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

            // Pick random kalimba file to be played during STT
            const files = fs.readdirSync(audioDir + "/sounds");
            const kalimbaFiles = files.filter(file => file.startsWith("kalimba-") && file.endsWith('.wav'));
            const randomKalimbaFile = kalimbaFiles[Math.floor(Math.random() * kalimbaFiles.length)];
            const randomKalimbaFileNameWithoutExtension = path.basename(randomKalimbaFile, '.wav');
            playSound(randomKalimbaFileNameWithoutExtension);
            ledHeartbeatInterval = setInterval(_ => led.writeSync(led.readSync() ^ 1), 625);

            //vosk STT-Analyse der aufgenommenen wav-Datei
            exec(voskSTTcommand, (err, searchTerm, stderr) => {
                console.log("vosk-api stt: " + searchTerm);

                //Suchindex aus vorher erstellter JSON-Datei anlegen fuer Suche nach Playlist
                fs.readJSON(__dirname + '/sttIndex.json').then(jsonData => {

                    //TODO: Index nur einmal schreiben
                    console.log("before minisearch index")
                    const miniSearch = new MiniSearch({
                        //fileds to index
                        fields: ['name'],
                        //fields to return with search results
                        storeFields: ['name', 'lang', 'topMode', 'mode'],
                    });

                    //Index anlegen und Prefix-Suche starten
                    miniSearch.addAll(jsonData);
                    const results = miniSearch.search(searchTerm, {
                        prefix: true
                    });

                    //Calculation Sound stoppen, Stop heartbeat led und led off
                    singleSoundPlayer.stop();
                    clearInterval(ledHeartbeatInterval);
                    led.writeSync(0);

                    //Wenn es Treffer gibt
                    if (results.length) {
                        const item = results[0];

                        //Wenn der Audio Player bereits laeuft, Nachricht an WSS schicken mit neuer Playlist -> dort wird Name der Playlist vorgelesen
                        if (port === 8080) {
                            console.log("Audio Player läuft bereits -> neue Setlist setzen");
                            ws.send(JSON.stringify({
                                type: "set-playlist-read",
                                value: {
                                    name: item.name,
                                    lang: item.lang || "de-DE",
                                    mode: item.topMode,
                                    path: item.mode + "/" + item.id
                                }
                            }));
                            buttonLock = false;
                        }

                        //der Audio Player laeuft gerade nicht, daher muss dieser per http-Aufruf gestartet werden
                        else {
                            console.log("Audio Player muss per http gestartet werden");

                            //Clever: lastSession-Datei anlegen, die beim Start des AudioServers geladen wird, Flag readPlaylist damit Name der Playlist vorgelesen wird
                            fs.writeJson(__dirname + "/../AudioServer/lastSession.json", {
                                path: audioFilesDir + "/" + item.topMode + "/" + item.mode + "/" + item.id,
                                activeItem: item.mode + "/" + item.id,
                                activeItemName: item.name,
                                activeItemLang: item.lang || "de-DE",
                                position: 0,
                                readPlaylist: true
                            }).then(() => {
                                http.get("http://localhost/php/activateAudioApp.php?mode=audio");
                            });
                        }
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
    buttonLock = false;
    //TODO: kein unpause beep in server.js
    playSound("stt-error");
    ws.send(JSON.stringify({
        type: "toggle-paused",
        value: false
    }));
}

//Einzelsound abspielen
function playSound(sound) {
    singleSoundPlayer.play({ path: audioDir + "/sounds/" + sound + ".wav" });
}