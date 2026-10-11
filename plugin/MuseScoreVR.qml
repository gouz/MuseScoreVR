// MuseScoreVR — configure the orchestra of the open score and send it to the VR headset.
// The plugin starts its own server (bin/, built by tools/build-plugin.js): the server renders the score with
// MuseScore's command line, serves the headset page over HTTPS on the Wi-Fi, and stops with MuseScore.
// The plugin talks to it over HTTP on this PC only (see tools/serve.js).
import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs as Dialogs
import MuseScore 3.0
import "layout.mjs" as Layout

MuseScore {
    id: root
    title: "MuseScoreVR"
    description: "Écouter la partition depuis l'intérieur de l'orchestre, dans un casque de réalité virtuelle"
    version: "0.1"
    thumbnailName: "logo.png"
    pluginType: "dialog"
    requiresScore: true
    width: 960
    height: 660

    readonly property string server: "http://127.0.0.1:8480"
    readonly property color bg: "#111317"
    readonly property color panel: "#191c22"
    readonly property color line: "#2a2e37"
    readonly property color fg: "#e4e6eb"
    readonly property color dim: "#8b909c"
    readonly property color accent: "#4f8cff"

    property int startTries: 0
    property var status: ({})        // last /api/status
    property var project: null       // project.json of the open project
    property var parts: []           // project parts, + hue
    property var seats: []           // { part, copy, x, y, moved }
    property int rev: 0              // bumped to refresh what depends on parts/seats
    property string sections: "decor"
    property string preset: "auto"   // seating preset (layout.mjs PRESETS)
    property real reverb: 0.35
    property bool directivity: true
    property string message: ""
    property bool busy: true
    property bool requested: false   // our render request was accepted: the server's project is now this score's

    QProcess { id: proc }            // the server; stops when the plugin window closes

    // --- server --------------------------------------------------------------
    function request(method, path, body, done) {
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () { if (x.readyState === XMLHttpRequest.DONE && done) done(x.status, x.responseText) };
        x.open(method, server + path);
        x.send(body === undefined ? null : JSON.stringify(body));
    }
    function localPath(url) { // file:///C:/x -> C:/x, file:///Users/x -> /Users/x
        var p = decodeURIComponent(String(url).replace(/^file:\/\//, ""));
        return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
    }
    function startServer() {
        var dir = localPath(Qt.resolvedUrl(".")).replace(/\/$/, "");
        var exe = dir + "/bin/" + ({ osx: "musescorevr-macos", windows: "musescorevr-windows.exe" }[Qt.platform.os] || "musescorevr-linux");
        proc.startWithArgs(exe, ["--web", dir + "/web", "--data", dir + "/data", "--mscore", Qt.application.arguments[0]]);
    }
    function poll() {
        request("GET", "/api/status", undefined, function (code, text) {
            if (code !== 200) { // not running yet: start it once, then wait for it
                if (startTries++ === 0) { message = "Démarrage de MuseScoreVR…"; startServer(); }
                else if (startTries > 20) { message = "Impossible de démarrer le serveur MuseScoreVR (dossier bin/ du plugin)."; busy = false; poller.stop(); }
                return;
            }
            var first = !status.urls;
            status = JSON.parse(text);
            if (first) exportScore();
            if (status.job) { busy = !status.job.error; message = status.job.error || "Préparation de " + status.job.title; }
            else if (requested && status.project && (!project || project.source !== status.project.source)) openProject(status.project);
        });
    }
    Timer { id: poller; interval: 700; repeat: true; running: true; triggeredOnStart: true; onTriggered: root.poll() }

    // the server reads the score's saved file (a plugin can't save a .mscz in MuseScore 4): it finds it by name in MuseScore's recent files
    function exportScore() {
        var name = curScore.title || curScore.scoreName || "partition";
        try { cmd("file-save") } catch (e) { console.warn(e) } // the file on disk = the score as it is now (asks where, if never saved)
        busy = true; requested = false; project = null; message = "Préparation de " + name + "…";
        request("POST", "/api/render", { names: [curScore.scoreName, curScore.title], title: name }, function (code, text) {
            if (code === 200) requested = true;
            else { message = code === 400 ? "Enregistre la partition (⌘S / Ctrl+S), puis rouvre MuseScoreVR — ou choisis le fichier :" : text; busy = false; }
        });
    }
    function render(path, name) {
        busy = true; requested = false; project = null; message = "Préparation de " + name + "…";
        request("POST", "/api/render", { path: path, title: name }, function (code, text) {
            if (code === 200) requested = true; else { message = text; busy = false; }
        });
    }
    Dialogs.FileDialog {
        id: pick
        title: "Partition enregistrée avec MuseScore 4"
        nameFilters: ["Partitions MuseScore (*.mscz)"]
        onAccepted: root.render(root.localPath(selectedFile), String(selectedFile).split("/").pop().replace(/\.mscz$/i, ""))
    }

    // --- project & seats -----------------------------------------------------
    function key(s) { return s.part.id + ":" + s.copy }
    function openProject(p) {
        project = p; busy = false; message = "";
        preset = Layout.PRESETS[p.preset] ? p.preset : "auto";
        sections = p.sections === "raw" ? "raw" : "decor"; reverb = p.reverb !== undefined ? p.reverb : 0.35; directivity = p.directivity !== false;
        var list = p.parts.slice().sort(function (a, b) { return (a.familyRank || 0) - (b.familyRank || 0) });
        var fams = [];
        list.forEach(function (q) { var f = q.family || q.id; if (fams.indexOf(f) < 0) fams.push(f) });
        list.forEach(function (q) { q.hue = fams.indexOf(q.family || q.id) / fams.length; if (q.count === undefined) q.count = 1 });
        parts = list;
        seats = []; layout();
        // chairs saved in the project: keep those that differ from the automatic place
        var saved = {}; (p.seats || []).forEach(function (s) { saved[s.part + ":" + s.copy] = s });
        seats.forEach(function (s) { var o = saved[key(s)]; if (o && Math.hypot(o.x - s.x, o.y - s.y) > 0.01) { s.x = o.x; s.y = o.y; s.moved = true } });
        rev++;
    }
    function layout() { // chairs the user moved keep their place
        var prev = {}; seats.forEach(function (s) { prev[key(s)] = s });
        var list = Layout.arrange(parts, preset);
        list.forEach(function (s) { var o = prev[key(s)]; if (o && o.moved) { s.x = o.x; s.y = o.y; s.moved = true } });
        seats = list; rev++;
    }
    function setPreset(id) { preset = id; seats.forEach(function (s) { s.moved = false }); layout() }
    function setCount(p, n) { p.count = Math.max(0, Math.min(8, n)); layout() }
    function seatName(s) { return s.part.name + (s.part.count > 1 ? " #" + (s.copy + 1) : "") }

    function send() {
        message = "Envoi au casque…";
        request("POST", "/api/send", {
            parts: parts.map(function (p) { return { id: p.id, count: p.count } }),
            seats: seats.map(function (s) { return { part: s.part.id, copy: s.copy, x: +s.x.toFixed(2), y: +s.y.toFixed(2) } }),
            preset: preset, sections: sections, reverb: reverb, directivity: directivity
        }, function (code, text) {
            if (code !== 200) { message = "Erreur : " + text; return }
            var n = JSON.parse(text).headsets;
            message = n ? "Envoyé à " + n + " casque" + (n > 1 ? "s" : "") + "." : "Enregistré : le casque le chargera en se connectant.";
        });
    }
    function control(cmd) { request("POST", "/api/control", { cmd: cmd }) }

    // --- interface -------------------------------------------------------------
    component Bar: Rectangle { // value 0..1, or -1: working, no idea how far
        id: bar
        property real value: 0
        implicitHeight: 6; radius: 3; color: root.line; clip: true
        onValueChanged: if (value >= 0) fill.x = 0
        Rectangle {
            id: fill
            height: bar.height; radius: 3; color: root.accent
            width: bar.value < 0 ? bar.width / 3 : bar.width * bar.value
            SequentialAnimation on x { // back and forth while MuseScore works
                running: bar.value < 0; loops: Animation.Infinite
                NumberAnimation { from: 0; to: bar.width * 2 / 3; duration: 900; easing.type: Easing.InOutQuad }
                NumberAnimation { from: bar.width * 2 / 3; to: 0; duration: 900; easing.type: Easing.InOutQuad }
            }
        }
    }
    function tasks() { return status.job && status.job.tasks || [] }
    function overall() { var t = tasks(); return t.length ? t.reduce(function (a, x) { return a + Math.max(0, x.value) }, 0) / t.length : -1 }
    component Btn: Rectangle {
        property alias text: label.text
        property bool primary: false
        property bool enabled2: true
        signal clicked()
        implicitWidth: label.implicitWidth + 22; implicitHeight: 30; radius: 6
        color: primary ? root.accent : (mouse.containsMouse && enabled2 ? "#2f3440" : "#262a33")
        border.color: primary ? root.accent : root.line
        opacity: enabled2 ? 1 : 0.4
        Text { id: label; anchors.centerIn: parent; color: root.fg; font.pixelSize: 13 }
        MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; enabled: parent.enabled2; onClicked: parent.clicked() }
    }

    Rectangle {
        anchors.fill: parent
        color: root.bg

        // top bar
        Rectangle {
            id: top
            anchors { left: parent.left; right: parent.right; top: parent.top }
            height: 48; color: root.panel
            Row { // all on the left: MuseScore may open the window narrower than asked
                anchors { left: parent.left; leftMargin: 14; verticalCenter: parent.verticalCenter }
                spacing: 6
                Text { text: "MuseScoreVR"; color: root.fg; font.pixelSize: 15; font.bold: true; anchors.verticalCenter: parent.verticalCenter }
                Item { width: 12; height: 1 }
                Btn { text: "Envoyer au casque"; primary: true; enabled2: !!root.project && !root.busy; onClicked: root.send() }
                Item { width: 12; height: 1 }
                Btn { text: "▶ Lecture"; enabled2: !!root.status.headsets; onClicked: root.control("play") }
                Btn { text: "❚❚ Pause"; enabled2: !!root.status.headsets; onClicked: root.control("pause") }
                Btn { text: "■ Stop"; enabled2: !!root.status.headsets; onClicked: root.control("stop") }
                Item { width: 12; height: 1 }
                Rectangle { width: 8; height: 8; radius: 4; anchors.verticalCenter: parent.verticalCenter; color: root.status.headsets ? "#3ecf8e" : "#555" }
                Text {
                    anchors.verticalCenter: parent.verticalCenter; color: root.status.headsets ? root.fg : root.dim; font.pixelSize: 13
                    text: root.status.headsets ? root.status.headsets + " casque" + (root.status.headsets > 1 ? "s connectés" : " connecté") : "aucun casque"
                }
            }
            Rectangle { anchors { left: parent.left; right: parent.right; bottom: parent.bottom } height: 1; color: root.line }
        }

        // musicians and sound options
        Rectangle {
            id: side
            anchors { left: parent.left; top: top.bottom; bottom: bottom.top }
            width: 290; color: root.panel
            Rectangle { anchors { right: parent.right; top: parent.top; bottom: parent.bottom } width: 1; color: root.line }
            Flickable {
                anchors.fill: parent; anchors.margins: 14
                contentHeight: col.height; clip: true
                Column {
                    id: col
                    width: parent.width; spacing: 4
                    Text { color: root.dim; font.pixelSize: 11; font.capitalization: Font.AllUppercase; font.letterSpacing: 1; text: "Disposition" }
                    Flow {
                        width: col.width; spacing: 6
                        Repeater {
                            model: Object.keys(Layout.PRESETS)
                            Btn {
                                required property string modelData
                                text: Layout.PRESETS[modelData].name
                                primary: root.preset === modelData
                                onClicked: root.setPreset(modelData)
                            }
                        }
                    }
                    Item { width: 1; height: 10 }
                    Text {
                        color: root.dim; font.pixelSize: 11; font.capitalization: Font.AllUppercase; font.letterSpacing: 1
                        text: "Musiciens" + (root.rev >= 0 && root.seats.length ? " · " + root.seats.length : "")
                    }
                    Repeater {
                        model: root.rev >= 0 ? root.parts : []
                        Column {
                            width: col.width
                            required property var modelData
                            required property int index
                            Text { // family header when the family changes
                                visible: index === 0 || root.parts[index - 1].family !== modelData.family
                                height: visible ? 26 : 0; verticalAlignment: Text.AlignBottom
                                text: "■ " + (modelData.familyName || modelData.family || ""); font.pixelSize: 12; font.bold: true
                                color: Qt.hsla(modelData.hue, 0.6, 0.62, 1)
                            }
                            Row {
                                width: parent.width; height: 28; spacing: 6
                                Text {
                                    width: parent.width - 100; anchors.verticalCenter: parent.verticalCenter; leftPadding: 14; elide: Text.ElideRight
                                    text: modelData.name; color: modelData.count ? root.fg : root.dim; font.pixelSize: 13; font.strikeout: !modelData.count
                                }
                                Btn { text: "−"; implicitWidth: 26; enabled2: modelData.count > 0; onClicked: root.setCount(modelData, modelData.count - 1) }
                                Text { width: 18; horizontalAlignment: Text.AlignHCenter; anchors.verticalCenter: parent.verticalCenter; color: root.fg; text: root.rev >= 0 ? modelData.count : "" }
                                Btn { text: "+"; implicitWidth: 26; enabled2: modelData.count < 8; onClicked: root.setCount(modelData, modelData.count + 1) }
                            }
                        }
                    }
                    Item { width: 1; height: 14 }
                    Text { color: root.dim; font.pixelSize: 11; font.capitalization: Font.AllUppercase; font.letterSpacing: 1; text: "Rendu sonore" }
                    RadioButton { text: "Pupitres naturels"; checked: root.sections === "decor"; onClicked: root.sections = "decor"; palette.windowText: root.fg }
                    RadioButton { text: "Copies identiques"; checked: root.sections === "raw"; onClicked: root.sections = "raw"; palette.windowText: root.fg }
                    CheckBox { text: "Rayonnement des instruments"; checked: root.directivity; onToggled: root.directivity = checked; palette.windowText: root.fg }
                    Text { text: "Réverbération"; color: root.fg; font.pixelSize: 13 }
                    Slider { width: col.width; from: 0; to: 1; value: root.reverb; onMoved: root.reverb = value }
                    Text { width: col.width; wrapMode: Text.Wrap; color: root.dim; font.pixelSize: 11; text: "Les réglages partent avec « Envoyer au casque »." }
                }
            }
        }

        // seat plan
        Canvas {
            id: plan
            anchors { left: side.right; right: parent.right; top: top.bottom; bottom: bottom.top }
            property real px: 40
            property var drag: null
            property var hover: null
            property int revSeen: root.rev
            onRevSeenChanged: requestPaint()
            onWidthChanged: requestPaint()
            onHeightChanged: requestPaint()
            function toPx(x, y) { return [width / 2 + x * px, height * 0.8 + y * px] }
            function toM(x, y) { return [(x - width / 2) / px, (y - height * 0.8) / px] }
            function at(mx, my) {
                var m = toM(mx, my), r = 16 / px;
                for (var i = 0; i < root.seats.length; i++) { var s = root.seats[i]; if (Math.hypot(s.x - m[0], s.y - m[1]) < r) return s }
                return null;
            }
            onPaint: {
                var g = getContext("2d"), seats = root.seats;
                g.reset(); g.fillStyle = root.bg; g.fillRect(0, 0, width, height);
                if (!seats.length) return;
                if (!drag) {
                    var w = 1.5, h = 1.5;
                    seats.forEach(function (s) { w = Math.max(w, Math.abs(s.x) + 1.5); h = Math.max(h, -s.y + 1.5) });
                    px = Math.min(width / 2 / w, height * 0.8 / h, 140);
                }
                var c = toPx(0, 0);
                g.strokeStyle = "rgba(255,255,255,0.07)"; g.fillStyle = "rgba(255,255,255,0.25)"; g.lineWidth = 1; g.font = "10px sans-serif";
                for (var r = 2; r * px < Math.max(width, height); r += 2) {
                    g.beginPath(); g.arc(c[0], c[1], r * px, Math.PI, 2 * Math.PI); g.stroke();
                    g.fillText(r + " m", c[0] + r * px + 4, c[1] - 4);
                }
                var fams = {};
                seats.forEach(function (s) { var f = s.part.family || s.part.id; (fams[f] = fams[f] || []).push(s) });
                for (var f in fams) { // family zones
                    g.fillStyle = Qt.hsla(fams[f][0].part.hue, 0.6, 0.5, 0.1); g.beginPath();
                    fams[f].forEach(function (s) { var p = toPx(s.x, s.y); g.moveTo(p[0] + 0.7 * px, p[1]); g.arc(p[0], p[1], 0.7 * px, 0, 2 * Math.PI) });
                    g.fill();
                }
                g.textAlign = "center"; g.font = "11px sans-serif";
                seats.forEach(function (s) {
                    var p = toPx(s.x, s.y), on = s === hover || s === drag;
                    g.fillStyle = Qt.hsla(s.part.hue, 0.6, on ? 0.62 : 0.45, 1); g.fillRect(p[0] - 10, p[1] - 10, 20, 20);
                    if (on) { g.strokeStyle = "#ffffff"; g.lineWidth = 2; g.strokeRect(p[0] - 14, p[1] - 14, 28, 28) }
                    g.fillStyle = on ? "#ffffff" : "#a9aebb"; g.fillText(root.seatName(s), p[0], p[1] + 27);
                });
                g.fillStyle = "#ffffff"; g.beginPath(); g.moveTo(c[0], c[1] - 11); g.lineTo(c[0] + 11, c[1]); g.lineTo(c[0], c[1] + 11); g.lineTo(c[0] - 11, c[1]); g.fill();
                g.fillText("chef", c[0], c[1] + 27);
            }
            MouseArea {
                anchors.fill: parent; hoverEnabled: true
                cursorShape: plan.drag ? Qt.ClosedHandCursor : plan.hover ? Qt.OpenHandCursor : Qt.ArrowCursor
                onPressed: function (e) { plan.drag = plan.at(e.x, e.y) }
                onPositionChanged: function (e) {
                    if (plan.drag && pressed) { var m = plan.toM(e.x, e.y); plan.drag.x = m[0]; plan.drag.y = m[1]; plan.drag.moved = true; plan.requestPaint(); return }
                    var h = plan.at(e.x, e.y); if (h !== plan.hover) { plan.hover = h; plan.requestPaint() }
                }
                onReleased: { if (plan.drag) { plan.drag = null; root.rev++ } }
            }
            Btn {
                anchors { right: parent.right; top: parent.top; margins: 12 }
                visible: root.rev >= 0 && root.seats.some(function (s) { return s.moved })
                text: "Replacer automatiquement"
                onClicked: { root.seats.forEach(function (s) { s.moved = false }); root.layout() }
            }
            Text {
                anchors { left: parent.left; bottom: parent.bottom; margins: 12 }
                visible: !!root.project; color: root.dim; font.pixelSize: 12
                text: "Glisser un musicien pour le déplacer · le chef est au ◆"
            }
            // render progress / errors
            Rectangle {
                anchors.centerIn: parent
                visible: root.busy || (!root.project && root.message !== "")
                width: Math.min(480, parent.width - 40); height: box.height + 36; radius: 12
                color: root.panel; border.color: root.line
                Column {
                    id: box
                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 18 }
                    spacing: 12
                    Text { width: parent.width; wrapMode: Text.Wrap; color: root.fg; font.pixelSize: 14; text: root.message || "…" }
                    Bar { width: parent.width; visible: root.busy; value: root.overall() }
                    ListView { // one line per part, then the music stands
                        id: taskList
                        width: parent.width; height: Math.min(contentHeight, 300); clip: true; spacing: 8
                        visible: root.busy && count > 0
                        model: root.tasks()
                        onModelChanged: { // follow the task in progress
                            var i = model.findIndex(function (t) { return t.value < 1 }); if (i >= 0) positionViewAtIndex(i, ListView.Contain)
                        }
                        delegate: Column {
                            required property var modelData
                            width: taskList.width; spacing: 3
                            Item {
                                width: parent.width; height: 16
                                Text { text: modelData.name; color: modelData.value === 0 ? root.dim : root.fg; font.pixelSize: 12; elide: Text.ElideRight; width: parent.width * 0.5 }
                                Text { anchors.right: parent.right; text: modelData.step + (modelData.value > 0 && modelData.value < 1 ? " " + Math.round(modelData.value * 100) + " %" : ""); color: root.dim; font.pixelSize: 11 }
                            }
                            Bar { width: parent.width; height: 4; value: modelData.value; opacity: modelData.value === 0 ? 0.4 : 1 }
                        }
                    }
                    Text {
                        width: parent.width; wrapMode: Text.Wrap; color: root.dim; font.pixelSize: 12; visible: root.busy
                        text: "MuseScore rend chaque partie avec les MuseSounds (≈ 30 s par partie). Le résultat est gardé : la prochaine ouverture de cette partition sera immédiate."
                    }
                    Btn { visible: !root.busy; text: "Choisir le fichier .mscz enregistré…"; onClicked: pick.open() }
                }
            }
        }

        // where to point the headset, last message
        Rectangle {
            id: bottom
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
            height: 40; color: root.panel
            Rectangle { anchors { left: parent.left; right: parent.right; top: parent.top } height: 1; color: root.line }
            TextEdit { // selectable, to copy the address
                anchors { left: parent.left; leftMargin: 14; verticalCenter: parent.verticalCenter }
                readOnly: true; selectByMouse: true; color: root.fg; font.pixelSize: 13
                text: root.status.urls && root.status.urls.length ? "Dans le navigateur du Quest : " + root.status.urls.join("  ou  ") : ""
            }
            Text {
                anchors { right: parent.right; rightMargin: 14; verticalCenter: parent.verticalCenter }
                visible: !!root.project; color: root.dim; font.pixelSize: 13; text: root.project ? root.message : ""
            }
        }
    }
}
