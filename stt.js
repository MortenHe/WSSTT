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

//Mikroaufnahme (channel 1 = mono)
const micInstance = mic({
    rate: '48000',
    channels: '1',
    device: "hw:2,0",
    debug: false
});
const micInputStream = micInstance.getAudioStream();
const outputFileStream = new FileWriter(__dirname + '/stt.wav', {
    sampleRate: 48000,
    channels: 1
});
micInputStream.pipe(outputFileStream);

//AudioDir holen fuer Erstellung des Playlist-Aufrufs ueber lastSession.json
const audioDir = fs.readJSONSync(__dirname + "/../AudioServer/config.json").audioDir + "/wap/mp3";

//Button und LED
const button = new Gpio(6, 'in', 'both', { debounceTimeout: 200 });
const led = new Gpio(21, 'out');

//Lock-Flag, damit Button nicht mehrfach gleichzeitig gedrueckt werden kann
var buttonLock = false;

//Aufnahmezeit stoppen -> Mindestlaenge fuer Aufnahme
var startTime;

//Wenn Verbindung mit WSS hergestellt wird
ws.on('open', function open() {
    console.log("connected to wss from stt search");

    //Wenn Button gedrueckt wird -> Aufnahme starten
    button.watch(function (err, value) {

        //Button pressed
        if (!value) {

            //Wenn gerade schon eine STT Berechnung laueft -> abbrechen
            if (buttonLock) {
                console.log("lock active. please wait");
                return;
            }

            console.log("button pressed -> Set lock and start timer");
            buttonLock = true;
            startTime = new Date().getTime();

            console.log("LED on");
            led.write(1);

            //Player pausieren (falls er gerade laueft), damit man Mikro besser hoert
            ws.send(JSON.stringify({
                type: "pause-if-playing",
                value: false
            }));

            //Aufnahme starten
            micInstance.start();
        }

        //Button released
        else {
            console.log("button released -> LED off & stop timer");
            led.write(0);
            const recordingTime = new Date().getTime() - startTime;

            //Aufnahme stoppen
            micInstance.stop();

            //Wenn die Aufnahme zu kurz war, Player wieder starten und Lock zuruecksetzen
            if (recordingTime < 2000) {
                console.log("recording was too short");
                resumePlaying();
                return;
            }

            //STT-Analyse der aufgenommenen wav-Datei
            const command = "cd " + __dirname + "/../vosk-api/python/example && python3 stt-mh.py " + __dirname + "/stt.wav";
            exec(command, (err, searchTerm, stderr) => {
                console.log("Speech To Text: " + searchTerm);

                //Suchindex aus vorher erstellter JSON-Datei anlegen fuer Suche nach Playlist
                fs.readJSON(__dirname + '/sttIndex.json').then(jsonData => {
                    const miniSearch = new MiniSearch({
                        fields: ['name', 'tracks'],
                        storeFields: ['name', 'topMode', 'mode', 'allowRandom'] // fields to return with search results
                    });

                    //TODO: remove
                    //searchTerm = "benjamin verliebt"

                    //Index anlegen und Prefix-Suche starten
                    miniSearch.addAll(jsonData);
                    const results = miniSearch.search(searchTerm, {
                        prefix: true
                    })

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

                            //Sprachausgabe fuer ausgewaehlte Playlist und dann Playlist starten
                            const ttsCommand = `
                            pico2wave -l de-DE -w ${__dirname}/tts.wav '${item.name}' &&
                            ffmpeg -i ${__dirname}/tts.wav -af acompressor=threshold=-11dB:ratio=9:attack=200:release=1000:makeup=2 ${__dirname}/tts-comp.wav &&
                            aplay ${__dirname}/tts-comp.wav &&
                            rm ${__dirname}/tts.wav &&
                            rm ${__dirname}/tts-comp.wav`;
                            exec(ttsCommand, (err, data, stderr) => {
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
        }
    });
});

//Kein Playliststart durch STT moeglich -> bisherige Playlist fortfuehren
function resumePlaying() {
    console.log("resume playing");

    //Lock zuruecksetzen, damit Button wieder gedrueckt werden kann
    buttonLock = false;

    //Nachricht an WSS schicken: Playlist wieder fortfuehren
    ws.send(JSON.stringify({
        type: "toggle-paused",
        value: false
    }));
}