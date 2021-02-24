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

//Mikroaufnahme
const micInstance = mic({
    rate: '16000',
    channels: '1',
    debug: false
});
const micInputStream = micInstance.getAudioStream();
const outputFileStream = new FileWriter(__dirname + '/stt.wav', {
    sampleRate: 16000,
    channels: 1
});
micInputStream.pipe(outputFileStream);

//AudioDir holen fuer Erstellung des Playlist-Aufrufs ueber lastSession.json
const audioDir = fs.readJSONSync(__dirname + "/../AudioServer/config.json").audioDir + "/wap/mp3";

//Button und LED
const button = new Gpio(6, 'in', 'both', { debounceTimeout: 200 });
const led = new Gpio(21, 'out');

//Wenn Verbindung mit WSS hergestellt wird
ws.on('open', function open() {
    console.log("connected to wss from stt search");

    //Wenn Button gedrueckt wird -> Aufnahme starten
    button.watch(function (err, value) {

        //Button pressed
        if (!value) {
            console.log("pressed -> LED on");
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
            console.log("button released -> LED off");
            led.write(0);

            //Aufnahme stoppen
            micInstance.stop();

            //STT-Analyse der aufgenommenen wav-Datei
            const command = "cd /../vosk-api/python/example && python3 test_simple.py " + __dirname + "/stt.wav";
            exec(command, (err, searchTerm, stderr) => {
                console.log("Speech To Text aussen: " + searchTerm);

                //Suchindex aus vorher erstellter JSON-Datei anlegen fuer Suche nach Playlist
                fs.readJSON(__dirname + '/sstIndex.json').then(jsonData => {
                    const miniSearch = new MiniSearch({
                        fields: ['name', 'tracks'],
                        storeFields: ['name', 'topMode', 'mode', 'allowRandom'] // fields to return with search results
                    });
                    console.log("Speech To Text innen: " + searchTerm);

                    searchTerm = "benjamin verliebt"
                    //searchTerm = "öfff"

                    //Index anlegen und Prefix-Suche starten
                    miniSearch.addAll(jsonData);
                    const results = miniSearch.search(searchTerm, {
                        prefix: true
                    })

                    //Wenn es Treffer gibt
                    if (results.length) {
                        item = results[0];
                        if (item.mode === "bebl") {
                            console.log("hat bebl")

                            //Clever: lastSession-Datei anlegen, die beim Start des AudioServers geladen wird
                            fs.writeJson(__dirname + "/../AudioServer/lastSession.json", {
                                path: audioDir + "/" + item.topMode + "/" + item.mode + "/" + item.id,
                                activeItem: item.mode + "/" + item.id,
                                activeItemName: item.name,
                                allowRandom: item.allowRandom,
                                position: 0
                            }).then(() => {

                                //Sprachausgabe fuer ausgewaehlte Playlist und dann Playlist starten
                                const ttsCommand = "pico2wave -l de-DE -w " + __dirname + "/tts.wav '" + item.name + "' && aplay " + __dirname + "/tts.wav && rm " + __dirname + "/tts.wav";
                                exec(ttsCommand, (err, data, stderr) => {
                                    http.get("http://localhost/php/activateAudioApp.php?mode=audio");
                                });
                            });
                        }
                        else {
                            console.log("kein bebl");
                        }
                    }
                    else {
                        console.log("no results for sst -> unpause player");

                        //Nachricht an WSS schicken: Pause falls Playlist gerade laeuft, damit man Mikro besser hoert
                        ws.send(JSON.stringify({
                            type: "toggle-paused",
                            value: false
                        }));
                    }
                });
            });
        }
    });
});