const { app, BrowserWindow, ipcMain, shell, desktopCapturer } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');
const { exec, spawn } = require('child_process');

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1054863027448598538/SkcZOyeX9MbJoYpgGf-HOnN5HlN-9BDQDd9y6veVkJbEiDoiGsPqZ4hGq3Y-6q0UcDz_';

let win;
let screenshotInterval = null;
let SETTINGS_FILE;
let AGREEMENT_FILE;
let SCREENSHOTS_DIR;

app.whenReady().then(() => {
    SETTINGS_FILE   = path.join(app.getPath('userData'), 'settings.json');
    AGREEMENT_FILE  = path.join(app.getPath('userData'), 'agreement.json');
    SCREENSHOTS_DIR = path.join(app.getPath('userData'), 'screenshots');

    if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    createWindow();
});

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE)); }
    catch { return { serverIp: '127.0.0.1:28015', screenshotInterval: 5, screenshotUploadUrl: '', playerName: '' }; }
}

function saveSettings(s) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function isAgreementAccepted() {
    try {
        const a = JSON.parse(fs.readFileSync(AGREEMENT_FILE));
        return a.accepted === true;
    } catch { return false; }
}

function acceptAgreement(playerName) {
    fs.writeFileSync(AGREEMENT_FILE, JSON.stringify({
        accepted: true,
        playerName,
        date: new Date().toISOString()
    }));
}

function createWindow() {
    win = new BrowserWindow({
        width: 800, height: 500,
        resizable: false,
        frame: false,
        backgroundColor: '#080A0F',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    // Показываем соглашение или сразу лаунчер
    if (!isAgreementAccepted()) {
        win.loadFile('agreement.html');
    } else {
        win.loadFile('launcher.html');
        startScreenshotScheduler();
    }
}

app.on('window-all-closed', () => {
    stopScreenshotScheduler();
    app.quit();
});

// ── Window controls ────────────────────────────────────────────────────
ipcMain.on('minimize', () => win.minimize());
ipcMain.on('close',    () => { stopScreenshotScheduler(); app.quit(); });

// ── Agreement ──────────────────────────────────────────────────────────
ipcMain.on('accept-agreement', (e, playerName) => {
    acceptAgreement(playerName);
    win.loadFile('launcher.html');
    startScreenshotScheduler();
});

ipcMain.on('decline-agreement', () => {
    app.quit();
});

// ── Launch Rust ────────────────────────────────────────────────────────
ipcMain.on('launch-rust', (e, serverIp) => {
    shell.openExternal(`steam://connect/${serverIp}`);
    win.webContents.send('log', `Подключение к ${serverIp}...`);
});

ipcMain.on('open-discord', () => shell.openExternal('https://discord.gg/shadowrust'));
ipcMain.on('open-site',    () => shell.openExternal('http://localhost:3000'));

// ── Online ─────────────────────────────────────────────────────────────
ipcMain.on('get-online', () => {
    win.webContents.send('online', Math.floor(Math.random() * 40 + 30));
});

// ── Settings ───────────────────────────────────────────────────────────
ipcMain.on('save-settings', (e, s) => {
    saveSettings(s);
    // Перезапускаем интервал если изменился
    stopScreenshotScheduler();
    startScreenshotScheduler();
    win.webContents.send('settings-saved');
});

ipcMain.on('load-settings', () => {
    win.webContents.send('settings-loaded', loadSettings());
});

// ── Screenshot по команде с сервера ───────────────────────────────────
ipcMain.on('take-screenshot-now', () => {
    takeScreenshot('manual');
});

// ── Screenshot scheduler ───────────────────────────────────────────────
function startScreenshotScheduler() {
    const s = loadSettings();
    const minutes = Math.max(1, parseInt(s.screenshotInterval) || 5);

    win?.webContents.send('anticheat-status', {
        active: true,
        interval: minutes,
        nextIn: minutes
    });

    screenshotInterval = setInterval(() => {
        takeScreenshot('auto');
    }, minutes * 60 * 1000);

    console.log(`[AntiCheat] Скриншоты каждые ${minutes} мин`);
}

function stopScreenshotScheduler() {
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }
}

// ── Делаем скриншот ────────────────────────────────────────────────────
async function takeScreenshot(reason) {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1920, height: 1080 }
        });

        if (!sources || sources.length === 0) {
            console.error('[AntiCheat] Нет источников экрана');
            return;
        }

        const source = sources[0];
        const img    = source.thumbnail;
        const png    = img.toPNG();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const s         = loadSettings();
        const player    = s.playerName || 'unknown';
        const filename  = `${player}_${reason}_${timestamp}.png`;
        const filepath  = path.join(SCREENSHOTS_DIR, filename);

        // Сохраняем локально
        fs.writeFileSync(filepath, png);
        console.log(`[AntiCheat] Скриншот сохранён: ${filename}`);

        // Уведомляем UI
        win?.webContents.send('screenshot-taken', {
            filename,
            reason,
            time: new Date().toLocaleTimeString('ru'),
            size: Math.round(png.length / 1024) + ' KB'
        });

        // Всегда отправляем в Discord
        uploadToDiscord(png, filename, WEBHOOK_URL, player, reason);

    } catch (err) {
        console.error('[AntiCheat] Ошибка скриншота:', err.message);
        win?.webContents.send('screenshot-error', err.message);
    }
}

// ── Загрузка скриншота в Discord Webhook ──────────────────────────────
function uploadToDiscord(pngBuffer, filename, webhookUrl, player, reason) {
    try {
        const url = new URL(webhookUrl);

        // Embed с информацией об игроке
        const reasonLabel = reason === 'auto' ? '🕐 Автоматический' : '⚡ По запросу';
        const embedJson = JSON.stringify({
            embeds: [{
                title: '📸 AntiCheat Screenshot',
                color: reason === 'auto' ? 0x7B4FFF : 0xFF4757,
                fields: [
                    { name: '👤 Игрок',  value: `\`${player}\``,      inline: true },
                    { name: '📋 Причина', value: reasonLabel,          inline: true },
                    { name: '🕒 Время',   value: new Date().toLocaleString('ru'), inline: true },
                    { name: '📁 Файл',    value: `\`${filename}\``,   inline: false }
                ],
                footer: { text: 'ShadowRust AntiCheat' },
                timestamp: new Date().toISOString()
            }]
        });

        // Multipart: embed + файл
        const boundary = '----DiscordBoundary' + Date.now();
        const body = Buffer.concat([
            // Часть 1: JSON payload с embed
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="payload_json"\r\n` +
                `Content-Type: application/json\r\n\r\n` +
                embedJson + `\r\n`
            ),
            // Часть 2: PNG файл
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="files[0]"; filename="${filename}"\r\n` +
                `Content-Type: image/png\r\n\r\n`
            ),
            pngBuffer,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        const req = https.request({
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers: {
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 204) {
                    console.log(`[AntiCheat] Discord: отправлено успешно`);
                    win?.webContents.send('screenshot-uploaded', { filename, status: res.statusCode });
                } else {
                    console.error(`[AntiCheat] Discord ошибка ${res.statusCode}: ${data}`);
                    win?.webContents.send('screenshot-error', `Discord: ${res.statusCode}`);
                }
            });
        });

        req.on('error', err => {
            console.error('[AntiCheat] Discord ошибка:', err.message);
            win?.webContents.send('screenshot-error', err.message);
        });

        req.write(body);
        req.end();

    } catch (err) {
        console.error('[AntiCheat] Ошибка отправки в Discord:', err.message);
    }
}

// ── Открыть папку скриншотов ───────────────────────────────────────────
ipcMain.on('open-screenshots', () => {
    shell.openPath(SCREENSHOTS_DIR);
});

// GitHub репозиторий для обновлений
const GITHUB_USER = 'MrKotara';
const GITHUB_REPO = 'TestTestTest';
const VERSION_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/version.json`;

// Локальная версия
const LOCAL_VERSION = require('./version.json').version;

// ── Тихая проверка обновлений при старте ──────────────────────────────
ipcMain.on('check-update-silent', () => {
    checkGithubVersion(false);
});

ipcMain.on('check-update', () => {
    checkGithubVersion(true);
});

function checkGithubVersion(doUpdate) {
    const req = https.get(VERSION_URL, { headers: { 'User-Agent': 'ShadowRust-Launcher' } }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
            try {
                const remote = JSON.parse(data);
                const remoteVer = remote.version;
                const changelog = remote.changelog || '';
                const downloadUrl = remote.url || '';

                if (isNewerVersion(remoteVer, LOCAL_VERSION)) {
                    // Есть обновление
                    win.webContents.send('update-available', {
                        version: remoteVer,
                        changelog,
                        downloadUrl
                    });

                    if (doUpdate && downloadUrl) {
                        downloadUpdate(downloadUrl, remoteVer);
                    }
                } else {
                    if (doUpdate) {
                        win.webContents.send('update-done', '✓ Уже последняя версия');
                    }
                }
            } catch (e) {
                console.error('[Update] Ошибка парсинга version.json:', e.message);
                if (doUpdate) win.webContents.send('update-done', 'Ошибка проверки обновлений');
            }
        });
    });

    req.on('error', err => {
        console.error('[Update] Нет соединения:', err.message);
    });
}

// Сравнение версий "1.0.1" > "1.0.0"
function isNewerVersion(remote, local) {
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((r[i] || 0) > (l[i] || 0)) return true;
        if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
}

// Скачать и применить обновление
function downloadUpdate(url, newVersion) {
    win.webContents.send('update-progress', { text: 'Скачивание обновления...', pct: 5 });

    const tmpZip = path.join(app.getPath('temp'), 'shadowrust_update.zip');
    const file   = fs.createWriteStream(tmpZip);

    const doGet = (u) => {
        https.get(u, { headers: { 'User-Agent': 'ShadowRust-Launcher' } }, res => {
            // Следуем редиректам (GitHub releases делает redirect)
            if (res.statusCode === 301 || res.statusCode === 302) {
                doGet(res.headers.location);
                return;
            }

            const total = parseInt(res.headers['content-length'] || '0');
            let received = 0;

            res.on('data', chunk => {
                received += chunk.length;
                file.write(chunk);
                if (total > 0) {
                    const pct = Math.floor(5 + (received / total) * 70);
                    win.webContents.send('update-progress', {
                        text: `Скачивание... ${Math.round(received/1024)}KB / ${Math.round(total/1024)}KB`,
                        pct
                    });
                }
            });

            res.on('end', () => {
                file.close(() => {
                    win.webContents.send('update-progress', { text: 'Распаковка...', pct: 80 });

                    const extractDir = path.join(app.getPath('temp'), 'shadowrust_update');
                    exec(
                        `powershell -command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${extractDir}' -Force"`,
                        err => {
                            if (err) {
                                win.webContents.send('update-done', `Ошибка распаковки: ${err.message}`);
                                return;
                            }

                            win.webContents.send('update-progress', { text: 'Применение обновления...', pct: 90 });

                            // Копируем файлы поверх текущей папки лаунчера
                            const appDir = path.dirname(app.getPath('exe'));
                            exec(
                                `powershell -command "Copy-Item -Path '${extractDir}\\*' -Destination '${appDir}' -Recurse -Force"`,
                                err2 => {
                                    try { fs.unlinkSync(tmpZip); } catch {}

                                    if (err2) {
                                        win.webContents.send('update-done', `Ошибка копирования: ${err2.message}`);
                                        return;
                                    }

                                    // Обновляем локальный version.json
                                    const vPath = path.join(__dirname, 'version.json');
                                    fs.writeFileSync(vPath, JSON.stringify({ version: newVersion }, null, 2));

                                    win.webContents.send('update-progress', { text: 'Готово! Перезапуск...', pct: 100 });

                                    // Перезапускаем лаунчер
                                    setTimeout(() => {
                                        app.relaunch();
                                        app.exit(0);
                                    }, 1500);
                                }
                            );
                        }
                    );
                });
            });

            res.on('error', e => {
                win.webContents.send('update-done', `Ошибка загрузки: ${e.message}`);
            });
        }).on('error', e => {
            win.webContents.send('update-done', `Ошибка соединения: ${e.message}`);
        });
    };

    doGet(url);
}    const serverPath = s.serverPath || 'C:\\RustServer';

    win.webContents.send('update-progress', { text: 'Проверка SteamCMD...', pct: 5 });

    const steamCmd = path.join(serverPath, 'steamcmd.exe');

    if (!fs.existsSync(steamCmd)) {
        win.webContents.send('update-progress', { text: 'SteamCMD не найден. Скачивание...', pct: 10 });

        const zipPath = path.join(serverPath, 'steamcmd.zip');
        fs.mkdirSync(serverPath, { recursive: true });
        const file = fs.createWriteStream(zipPath);

        https.get('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', res => {
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                win.webContents.send('update-progress', { text: 'Распаковка SteamCMD...', pct: 25 });
                exec(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${serverPath}' -Force"`, () => {
                    try { fs.unlinkSync(zipPath); } catch {}
                    runSteamUpdate(serverPath);
                });
            });
        }).on('error', err => {
            win.webContents.send('update-done', `Ошибка: ${err.message}`);
        });
    } else {
        runSteamUpdate(serverPath);
    }
});

function runSteamUpdate(serverPath) {
    win.webContents.send('update-progress', { text: 'Обновление сервера через SteamCMD...', pct: 40 });

    const steamCmd = path.join(serverPath, 'steamcmd.exe');
    const proc = spawn(steamCmd, [
        '+force_install_dir', serverPath,
        '+login', 'anonymous',
        '+app_update', '258550',
        '+quit'
    ]);

    let lastPct = 40;

    proc.stdout.on('data', d => {
        const text = d.toString().trim();
        if (!text) return;

        // Парсим прогресс из вывода SteamCMD
        const match = text.match(/(\d+\.\d+)%/);
        if (match) {
            lastPct = Math.min(95, 40 + Math.floor(parseFloat(match[1]) * 0.55));
        }

        win.webContents.send('update-progress', {
            text: text.substring(0, 60),
            pct: lastPct
        });
    });

    proc.on('exit', code => {
        if (code === 0) {
            win.webContents.send('update-done', '✓ Обновление завершено!');
        } else {
            win.webContents.send('update-done', `Завершено (код ${code})`);
        }
    });

    proc.on('error', err => {
        win.webContents.send('update-done', `Ошибка: ${err.message}`);
    });
}

// ── Получить список скриншотов ─────────────────────────────────────────
ipcMain.on('get-screenshots', () => {
    try {
        const files = fs.readdirSync(SCREENSHOTS_DIR)
            .filter(f => f.endsWith('.png'))
            .map(f => {
                const stat = fs.statSync(path.join(SCREENSHOTS_DIR, f));
                return {
                    name: f,
                    size: Math.round(stat.size / 1024) + ' KB',
                    date: stat.mtime.toLocaleString('ru')
                };
            })
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 20);
        win.webContents.send('screenshots-list', files);
    } catch { win.webContents.send('screenshots-list', []); }
});
