const { execFile } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const FileWriter = require('wav').FileWriter;
const mic = require('mic');
const MiniSearch = require('minisearch');
const http = require('http');
const WebSocket = require('ws');
const Gpio = require('onoff').Gpio;
const singleSoundPlayer = require('node-wav-player');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const port = Number(process.argv[2]);
const ws = new WebSocket(`ws://localhost:${port}`);

const configFile = fs.readJSONSync(path.join(__dirname, '../AudioServer/config.json'));
const audioDir = configFile.audioDir;
const audioFilesDir = path.join(audioDir, 'wap/mp3');
const sttIndexFile = path.join(__dirname, 'sttIndex.json');
const audioSoundsDir = path.join(audioDir, 'sounds');

const button = new Gpio(6, 'in', 'falling', { debounceTimeout: 100 });
const led = new Gpio(26, 'out');
let ledHeartbeatInterval;
let buttonLock = false;
let miniSearch;
let kalimbaFiles = [];

const voskSTTArgs = [path.join(__dirname, '../vosk-api/python/example/stt-mh.py'), path.join(__dirname, 'stt.wav')];

function configure() {
    try {
        kalimbaFiles = fs.readdirSync(audioSoundsDir).filter(file => file.startsWith('kalimba-') && file.endsWith('.wav'));
    } catch (err) {
        console.warn('Could not read sounds directory', err);
        kalimbaFiles = [];
    }

    loadSearchIndex().catch(err => console.warn('Could not initialize STT index', err));

    process.on('SIGINT', shutdownGracefully);
    process.on('SIGTERM', shutdownGracefully);
}

async function loadSearchIndex() {
    try {
        const jsonData = await fs.readJSON(sttIndexFile);
        miniSearch = new MiniSearch({
            fields: ['name'],
            storeFields: ['name', 'lang', 'topMode', 'mode']
        });
        miniSearch.addAll(jsonData);
        console.log('STT index loaded (', jsonData.length, 'entries )');
    } catch (err) {
        console.error('Error loading STT index (sttIndex.json)', err);
        miniSearch = null;
    }
}

function getRandomKalimba() {
    if (!kalimbaFiles.length) return null;
    const idx = Math.floor(Math.random() * kalimbaFiles.length);
    return kalimbaFiles[idx];
}

async function runVoskSTT() {
    const cmd = 'python3';
    const args = ['stt-mh.py', path.join(__dirname, 'stt.wav')];
    const options = { cwd: path.join(__dirname, '../vosk-api/python/example'), timeout: 15000, maxBuffer: 1024 * 1024 * 2 };
    const { stdout } = await execFileAsync(cmd, args, options);
    return stdout.trim();
}

async function handleSttResult(searchTerm) {
    if (!searchTerm || !miniSearch) {
        console.log('No search term or no index');
        return false;
    }

    const results = miniSearch.search(searchTerm, { prefix: true });
    if (!results.length) {
        console.log('no results for stt', searchTerm);
        return false;
    }

    const item = results[0];
    const value = {
        name: item.name,
        lang: item.lang || 'de-DE',
        mode: item.topMode,
        path: `${item.mode}/${item.id}`
    };

    if (port === 8080) {
        console.log('Audio Player is running -> set playlist');
        sendWs({ type: 'set-playlist-read', value });
        return true;
    }

    await fs.writeJson(path.join(__dirname, '../AudioServer/lastSession.json'), {
        path: path.join(audioFilesDir, item.topMode, item.mode, item.id),
        activeItem: `${item.mode}/${item.id}`,
        activeItemName: item.name,
        activeItemLang: item.lang || 'de-DE',
        position: 0,
        readPlaylist: true
    });

    http.get('http://localhost/php/activateAudioApp.php?mode=audio').on('error', err => console.warn('failed to trigger audio app', err));
    return true;
}

function sendWs(payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function startHeartbeat() {
    if (ledHeartbeatInterval) clearInterval(ledHeartbeatInterval);
    ledHeartbeatInterval = setInterval(() => led.writeSync(led.readSync() ^ 1), 625);
}

function stopHeartbeat() {
    if (ledHeartbeatInterval) {
        clearInterval(ledHeartbeatInterval);
        ledHeartbeatInterval = null;
    }
    led.writeSync(0);
}

function releaseLock() {
    buttonLock = false;
}

function resumePlaying() {
    console.log('release lock, play error beep, resume playing');
    playSound('stt-error');
    sendWs({ type: 'toggle-paused', value: false });
    releaseLock();
}

function playSound(sound) {
    singleSoundPlayer.play({ path: path.join(audioDir, 'sounds', `${sound}.wav`) }).catch(err => console.warn('playSound error', err));
}

function shutdownGracefully() {
    clearInterval(ledHeartbeatInterval);
    button.unwatchAll();
    led.unexport();
    button.unexport();
    process.exit(0);
}

ws.on('open', () => {
    console.log('connected to wss from stt search');

    button.watch(async () => {
        if (buttonLock) {
            console.log('button pressed -> lock active. please wait');
            return;
        }

        buttonLock = true;
        playSound('stt-start');
        led.writeSync(1);
        sendWs({ type: 'pause-if-playing', value: false });

        const micInstance = mic({ rate: 48000, channels: 1, device: configFile.STTDevice, debug: false, exitOnSilence: 10 });
        const micInputStream = micInstance.getAudioStream();
        const outputFileStream = new FileWriter(path.join(__dirname, 'stt.wav'), { sampleRate: 48000, channels: 1 });

        micInputStream.pipe(outputFileStream);

        micInputStream.once('silence', async () => {
            console.log('Got SIGNAL silence -> stop mic, play calculating, led heartbeat, stt calculating');
            micInstance.stop();

            const randomFile = getRandomKalimba();
            if (randomFile) {
                playSound(path.basename(randomFile, '.wav'));
            }
            startHeartbeat();

            try {
                const searchTerm = (await runVoskSTT()).trim();
                console.log('vosk-api stt:', searchTerm);

                const found = await handleSttResult(searchTerm);
                if (!found) {
                    resumePlaying();
                }
            } catch (err) {
                console.error('STT run failed', err);
                resumePlaying();
            } finally {
                singleSoundPlayer.stop().catch(() => { });
                stopHeartbeat();
                releaseLock();
            }
        });

        micInstance.start();
    });
});

ws.on('error', err => console.error('WebSocket error', err));
ws.on('close', () => console.log('WebSocket closed'));

configure();