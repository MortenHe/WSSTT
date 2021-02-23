//Port 8080 (audio player) oder 9090 (sh audio player)
//TODO: port
const port = process.argv[2] || 8081;

//Mit WebsocketServer verbinden
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:' + port);

const { exec } = require('child_process');

const fs = require('fs-extra');
const FileWriter = require('wav').FileWriter;
const mic = require('mic'); // requires arecord or sox, see https://www.npmjs.com/package/mic
const MiniSearch = require('minisearch');
const http = require('http');


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

//AudioDir holen fuer Erstellung des Playlist-Aufrufs ueber lastSession.json
const audioDir = fs.readJSONSync("../AudioServer/config.json").audioDir;

micInputStream.pipe(outputFileStream);

//Wenn Verbindung mit WSS hergestellt wird
ws.on('open', function open() {
    console.log("connected to wss");

    //Nachricht an WSS schicken: Pause falls Playlist gerade laeuft, damit man Mikro besser hoert
    ws.send(JSON.stringify({
        type: "pause-if-playing",
        value: false
    }));

    micInstance.start();

    setTimeout(function () {
        micInstance.stop();
        const command = "cd /home/martin/github/vosk-api/python/example/ && python3 test_simple.py " + __dirname + "/stt.wav";
        exec(command, (err, searchTerm, stderr) => {
            console.log("Speech To Text aussen: " + searchTerm);

            fs.readJSON(__dirname + '/sstIndex.json').then(jsonData => {
                const miniSearch = new MiniSearch({
                    fields: ['name', 'tracks'], // fields to index for full-text search
                    storeFields: ['name', 'topMode', 'mode', 'allowRandom'] // fields to return with search results
                });

                console.log("Speech To Text innen: " + searchTerm);

                // Index all documents
                miniSearch.addAll(jsonData);

                //searchTerm = "bobs toller entwurf"
                //searchTerm = "abba best of"
                searchTerm = "benjamin verliebt sich"
                // Search with default options
                const results = miniSearch.search(searchTerm, {
                    prefix: true
                })

                //console.log(results[0]);
                if (results.length) {
                    item = results[0];
                    if (item.mode === "bebl") {
                        console.log("hat bebl")
                        fs.writeJson(__dirname + "/../AudioServer/lastSession.json", {
                            path: audioDir + "/" + item.topMode + "/" + item.mode + "/" + item.id,
                            activeItem: item.mode + "/" + item.id,
                            activeItemName: item.name,
                            allowRandom: item.allowRandom,
                            position: 0
                        }).then(() => {
                            const ttsCommand = "pico2wave -l de-DE -w " + __dirname + "/tts.wav '" + item.name + "' && aplay " + __dirname + "/tts.wav && rm " + __dirname + "/tts.wav";

                            exec(ttsCommand, (err, data, stderr) => {
                                console.log("done")
                                http.get("http://localhost/php/activateAudioApp.php?mode=audio");
                            })
                        });
                    }
                    else {
                        console.log("kein bebl");
                    }
                }
                else {
                    //TODO: Audio wieder starten
                    console.log("no results for sst");
                }
            });
        });
    }, 2000);
});