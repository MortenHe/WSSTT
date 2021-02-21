//Libs
const fs = require('fs-extra');

//Config
const configFile = fs.readJsonSync(__dirname + '/../AudioServer/config.json');

//Mit WebsocketServer verbinden
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:' + configFile.port);

//Wenn Verbindung mit WSS hergestellt wird
ws.on('open', function open() {
    console.log("connected to wss from tts index");

    //Wenn WS eine Nachricht von WSS empfaengt
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        const obj = JSON.parse(message);

        //Wenn JSON-Daten geliefert werden
        if (obj.type === "mainJSON") {

            //JSON-Array fuer Index erstellen            
            const mainJSON = obj.value;
            const indexJSON = [];
            for (const topMode of Object.keys(mainJSON)) {
                for (const item of mainJSON[topMode]["items"]) {

                    //Flaches Array erstellen fuer Suchindex mit allen Infos zu Mode, topMode, etc.
                    const indexObj = {
                        "id": item.file,
                        "name": item.name,
                        "tracks": item.tracks,
                        "mode": item.mode,
                        "topMode": topMode,
                        "allowRandom": mainJSON[topMode].allowRandom
                    }
                    indexJSON.push(indexObj);
                }
            }

            //Gesammelte JSON-Werte als Datei ablegen fuer Indexsuche
            console.log("CREATE TTS INDEX FILE")
            fs.writeJSON(__dirname + "/sstIndex.json", indexJSON);
        }
    });
});