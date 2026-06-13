/* ============================================================================
 * VLC TV — SMB proxy service  (Tizen Web Service application, Node.js runtime)
 * ----------------------------------------------------------------------------
 * The .wgt sandbox can't speak SMB (raw TCP 445 + the CIFS protocol), but a
 * hybrid <tizen:service> runs on the set's Node runtime and CAN open sockets.
 * This service is a tiny localhost HTTP server that:
 *
 *   POST /smb/connect   { host, share, user, pass, domain?, port? }
 *                       → NEGOTIATE + NTLMv2 SESSION_SETUP + TREE_CONNECT
 *   GET  /smb/list?path=/sub          → JSON [{ name, isDir, size }]
 *   GET  /smb/stream?path=/a/b.mkv    → byte stream, honours HTTP Range
 *   GET  /smb/ping                    → { ok:true } liveness check
 *
 * The web app points AVPlay at  http://127.0.0.1:8127/smb/stream?path=...
 * AVPlay then demuxes / seeks exactly like any other HTTP source; seeking
 * arrives as a Range request which we map to an SMB2 READ at offset/length.
 *
 * Self-contained on purpose: zero npm dependencies so there's nothing to
 * bundle or transpile for the ancient Node build on the TV.  Pure ES5.
 *
 * Scope of the embedded SMB2 client: SMB 2.0.2 / 2.1, NTLMv2 auth, optional
 * HMAC-SHA256 signing (used only when the server marks it required), read-only
 * (NEGOTIATE / SESSION_SETUP / TREE_CONNECT / CREATE / QUERY_DIRECTORY / READ /
 * CLOSE).  Enough to browse a share and stream files.
 * ==========================================================================*/

var http   = require('http');
var net    = require('net');
var crypto = require('crypto');

var PORT        = 8127;
var LISTEN_HOST = '127.0.0.1';

/* ── debug ring buffer, surfaced at GET /smb/debug/logs ──────────────────── */
var LOGS = [];
function log(msg, data) {
    var line = new Date().toISOString() + ' ' + msg +
               (data !== undefined ? ' ' + safeJson(data) : '');
    LOGS.push(line);
    if (LOGS.length > 2000) LOGS.shift();
    console.log(line);
}
function safeJson(d) { try { return typeof d === 'object' ? JSON.stringify(d) : String(d); } catch (e) { return ''; } }

/* ============================================================================
 * MD4  (RFC 1320) — needed for the NT hash; Node's crypto may lack md4 on the
 * TV's OpenSSL build, so we carry our own and never gamble on the provider.
 * ==========================================================================*/
function md4(buf) {
    function rol(x, n) { return (x << n) | (x >>> (32 - n)); }
    function add(a, b) { return (a + b) | 0; }
    var F = function (x, y, z) { return (x & y) | (~x & z); };
    var G = function (x, y, z) { return (x & y) | (x & z) | (y & z); };
    var H = function (x, y, z) { return x ^ y ^ z; };

    var len = buf.length;
    var bitLen = len * 8;
    var withPad = len + 1;
    while (withPad % 64 !== 56) withPad++;
    var m = Buffer.alloc(withPad + 8, 0);
    buf.copy(m, 0);
    m[len] = 0x80;
    m.writeUInt32LE(bitLen >>> 0, withPad);
    m.writeUInt32LE(Math.floor(bitLen / 4294967296) >>> 0, withPad + 4);

    var a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    var X = new Array(16);
    for (var off = 0; off < m.length; off += 64) {
        for (var i = 0; i < 16; i++) X[i] = m.readUInt32LE(off + i * 4);
        var aa = a, bb = b, cc = c, dd = d;
        var r1 = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
        var s1 = [3,7,11,19];
        for (i = 0; i < 16; i++) {
            var k = r1[i];
            var sh = s1[i % 4];
            if      ((i & 3) === 0) a = rol(add(a, F(b, c, d) + X[k] | 0), sh);
            else if ((i & 3) === 1) d = rol(add(d, F(a, b, c) + X[k] | 0), sh);
            else if ((i & 3) === 2) c = rol(add(c, F(d, a, b) + X[k] | 0), sh);
            else                    b = rol(add(b, F(c, d, a) + X[k] | 0), sh);
        }
        var r2 = [0,4,8,12,1,5,9,13,2,6,10,14,3,7,11,15];
        var s2 = [3,5,9,13];
        for (i = 0; i < 16; i++) {
            k = r2[i]; sh = s2[i % 4];
            var g = (0x5a827999) | 0;
            if      ((i & 3) === 0) a = rol(add(a, (G(b, c, d) + X[k] | 0) + g | 0), sh);
            else if ((i & 3) === 1) d = rol(add(d, (G(a, b, c) + X[k] | 0) + g | 0), sh);
            else if ((i & 3) === 2) c = rol(add(c, (G(d, a, b) + X[k] | 0) + g | 0), sh);
            else                    b = rol(add(b, (G(c, d, a) + X[k] | 0) + g | 0), sh);
        }
        var r3 = [0,8,4,12,2,10,6,14,1,9,5,13,3,11,7,15];
        var s3 = [3,9,11,15];
        for (i = 0; i < 16; i++) {
            k = r3[i]; sh = s3[i % 4];
            var h = (0x6ed9eba1) | 0;
            if      ((i & 3) === 0) a = rol(add(a, (H(b, c, d) + X[k] | 0) + h | 0), sh);
            else if ((i & 3) === 1) d = rol(add(d, (H(a, b, c) + X[k] | 0) + h | 0), sh);
            else if ((i & 3) === 2) c = rol(add(c, (H(d, a, b) + X[k] | 0) + h | 0), sh);
            else                    b = rol(add(b, (H(c, d, a) + X[k] | 0) + h | 0), sh);
        }
        a = add(a, aa); b = add(b, bb); c = add(c, cc); d = add(d, dd);
    }
    var out = Buffer.alloc(16);
    out.writeUInt32LE(a >>> 0, 0); out.writeUInt32LE(b >>> 0, 4);
    out.writeUInt32LE(c >>> 0, 8); out.writeUInt32LE(d >>> 0, 12);
    return out;
}
function hmacMd5(key, data)    { return crypto.createHmac('md5',    key).update(data).digest(); }
function hmacSha256(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function utf16le(str)          { return Buffer.from(str || '', 'ucs2'); }

/* ── 64-bit LE helpers (JS-number-safe up to 2^53 ≈ 9 PB, plenty for files) ─ */
function writeU64LE(b, off, n) { b.writeUInt32LE(n % 4294967296 >>> 0, off); b.writeUInt32LE(Math.floor(n / 4294967296) >>> 0, off + 4); }
function readU64LE(b, off)     { return b.readUInt32LE(off) + b.readUInt32LE(off + 4) * 4294967296; }

/* ============================================================================
 * SMB2 protocol constants
 * ==========================================================================*/
var SMB2 = {
    NEGOTIATE: 0x0000, SESSION_SETUP: 0x0001, LOGOFF: 0x0002,
    TREE_CONNECT: 0x0003, TREE_DISCONNECT: 0x0004, CREATE: 0x0005,
    CLOSE: 0x0006, READ: 0x0008, QUERY_DIRECTORY: 0x000E
};
var ST = {
    SUCCESS:               0x00000000,
    MORE_PROCESSING:       0xC0000016,
    NO_MORE_FILES:         0x80000006,
    END_OF_FILE:           0xC0000011,
    PENDING:               0x00000103
};
var FLAGS_SIGNED = 0x00000008;

/* NTLMSSP negotiate flags (Unicode + extended session security = NTLMv2). */
var NTLM_F = 0x00000001 | 0x00000004 | 0x00000200 | 0x00008000 | 0x00080000;
var NTLM_ANON = 0x00000800;   // NTLMSSP_NEGOTIATE_ANONYMOUS

/* ============================================================================
 * SmbConnection — one TCP socket to one share, request/response correlated by
 * MessageId so multiple in-flight reads (AVPlay loves to parallelise) are fine.
 * ==========================================================================*/
function SmbConnection(opts) {
    this.host    = opts.host;
    this.port    = opts.port || 445;
    this.share   = opts.share;
    this.user    = opts.user || '';
    this.pass    = opts.pass || '';
    this.domain  = opts.domain || '';
    this.anonymous = !!opts.anonymous;   // guest / no-login session
    this.socket  = null;
    this.rxbuf   = Buffer.alloc(0);
    this.msgId   = 0;
    this.sessionId = Buffer.alloc(8);
    this.treeId  = 0;
    this.signKey = null;          // set only if server requires signing
    this.signing = false;
    this.pending = {};            // messageId -> cb(status, header, body)
    this.dead    = false;
    this.dialect = 0;
}

SmbConnection.prototype._frame = function () {
    /* Direct-TCP transport: 4-byte length prefix (00 + 24-bit BE) per message. */
    while (this.rxbuf.length >= 4) {
        var msgLen = (this.rxbuf[1] << 16) | (this.rxbuf[2] << 8) | this.rxbuf[3];
        if (this.rxbuf.length < 4 + msgLen) break;
        var msg = this.rxbuf.slice(4, 4 + msgLen);
        this.rxbuf = this.rxbuf.slice(4 + msgLen);
        this._dispatch(msg);
    }
};
SmbConnection.prototype._dispatch = function (msg) {
    if (msg.length < 64) return;
    var status = msg.readUInt32LE(8);
    var mid    = readU64LE(msg, 24);
    /* Async interim STATUS_PENDING: ignore, the real response follows. */
    if (status === ST.PENDING) return;
    var cb = this.pending[mid];
    if (!cb) return;
    delete this.pending[mid];
    var body = msg.slice(64);
    cb(status, msg.slice(0, 64), body);
};
SmbConnection.prototype._die = function (why) {
    if (this.dead) return;
    this.dead = true;
    log('SMB_DEAD', why);
    var p = this.pending; this.pending = {};
    for (var k in p) try { p[k](-1, null, null); } catch (e) {}
    try { if (this.socket) this.socket.destroy(); } catch (e) {}
};

/* Build a 64-byte SMB2 sync header. */
SmbConnection.prototype._header = function (command, creditCharge) {
    var h = Buffer.alloc(64);
    h.writeUInt32BE(0xFE534D42, 0);         // 0xFE 'S' 'M' 'B'
    h.writeUInt16LE(64, 4);                  // StructureSize
    h.writeUInt16LE(creditCharge || 1, 6);   // CreditCharge
    h.writeUInt32LE(0, 8);                    // Status (req: 0)
    h.writeUInt16LE(command, 12);
    h.writeUInt16LE(64, 14);                  // CreditRequest (ask generously)
    h.writeUInt32LE(0, 16);                   // Flags
    h.writeUInt32LE(0, 20);                   // NextCommand
    var id = this.msgId++;
    writeU64LE(h, 24, id);
    h.writeUInt32LE(0, 32);                   // Reserved
    h.writeUInt32LE(this.treeId >>> 0, 36);
    this.sessionId.copy(h, 40);
    // Signature (48..63) left zero
    return { buf: h, id: id };
};

/* Send header+body, optionally signed, register the callback. */
SmbConnection.prototype._send = function (command, body, creditCharge, cb) {
    if (this.dead) return cb(-1, null, null);
    var hdr = this._header(command, creditCharge);
    if (this.signing && this.signKey) {
        hdr.buf.writeUInt32LE(FLAGS_SIGNED, 16);
        var full = Buffer.concat([hdr.buf, body]);
        var sig = hmacSha256(this.signKey, full).slice(0, 16);
        sig.copy(hdr.buf, 48);
        var packet = Buffer.concat([hdr.buf, body]);
    } else {
        packet = Buffer.concat([hdr.buf, body]);
    }
    this.pending[hdr.id] = cb;
    var pfx = Buffer.alloc(4);
    pfx[0] = 0;
    pfx[1] = (packet.length >> 16) & 0xFF;
    pfx[2] = (packet.length >> 8) & 0xFF;
    pfx[3] = packet.length & 0xFF;
    try { this.socket.write(Buffer.concat([pfx, packet])); }
    catch (e) { this._die('write:' + e.message); }
};

/* ── connect: open socket, then NEGOTIATE → SESSION_SETUP → TREE_CONNECT ──── */
SmbConnection.prototype.connect = function (done) {
    var self = this;
    this.socket = net.connect(this.port, this.host, function () {
        log('SMB_TCP_OPEN', self.host + ':' + self.port);
        self._negotiate(function (err) {
            if (err) return done(err);
            self._sessionSetup(function (err2) {
                if (err2) return done(err2);
                self._treeConnect(done);
            });
        });
    });
    this.socket.setNoDelay(true);
    this.socket.on('data', function (chunk) {
        self.rxbuf = Buffer.concat([self.rxbuf, chunk]);
        self._frame();
    });
    this.socket.on('error', function (e) { self._die('sock:' + e.message); done && done(e); });
    this.socket.on('close', function () { self._die('closed'); });
};

SmbConnection.prototype._negotiate = function (cb) {
    var self = this;
    var dialects = [0x0202, 0x0210];
    var body = Buffer.alloc(36 + dialects.length * 2);
    body.writeUInt16LE(36, 0);                       // StructureSize
    body.writeUInt16LE(dialects.length, 2);          // DialectCount
    body.writeUInt16LE(0x0001, 4);                   // SecurityMode = signing enabled
    body.writeUInt16LE(0, 6);                        // Reserved
    body.writeUInt32LE(0, 8);                        // Capabilities
    crypto.randomBytes(16).copy(body, 12);           // ClientGuid
    writeU64LE(body, 28, 0);                         // ClientStartTime
    for (var i = 0; i < dialects.length; i++) body.writeUInt16LE(dialects[i], 36 + i * 2);

    this._send(SMB2.NEGOTIATE, body, 1, function (status, hdr, resp) {
        if (status !== ST.SUCCESS) return cb(new Error('NEGOTIATE failed 0x' + (status >>> 0).toString(16)));
        self.dialect = resp.readUInt16LE(4);
        var securityMode = resp.readUInt16LE(2);
        self.signing = !!(securityMode & 0x0002); // server marks signing REQUIRED
        log('SMB_NEGOTIATE', { dialect: '0x' + self.dialect.toString(16), signingRequired: self.signing });
        cb(null);
    });
};

/* NTLMSSP type 1 (negotiate). */
function ntlmType1() {
    var b = Buffer.alloc(32);
    b.write('NTLMSSP\0', 0, 'binary');
    b.writeUInt32LE(1, 8);          // MessageType
    b.writeUInt32LE(NTLM_F, 12);    // NegotiateFlags
    // Domain + Workstation fields left zero
    return b;
}

/* Parse NTLMSSP type 2 (challenge): server challenge + target info blob. */
function parseNtlmType2(buf) {
    var serverChallenge = buf.slice(24, 32);
    var tiLen = buf.readUInt16LE(40);
    var tiOff = buf.readUInt32LE(44);
    var targetInfo = buf.slice(tiOff, tiOff + tiLen);
    return { challenge: serverChallenge, targetInfo: targetInfo };
}

/* Pull MsvAvTimestamp (AvId 0x07) out of target info if present. */
function findAvTimestamp(ti) {
    var p = 0;
    while (p + 4 <= ti.length) {
        var id = ti.readUInt16LE(p), len = ti.readUInt16LE(p + 2);
        if (id === 0x0000) break;          // MsvAvEOL
        if (id === 0x0007 && len === 8) return ti.slice(p + 4, p + 12);
        p += 4 + len;
    }
    return null;
}

/* NTLMSSP type 3 (authenticate) + the derived session key. */
SmbConnection.prototype._buildNtlmType3 = function (challengeBuf) {
    var t2 = parseNtlmType2(challengeBuf);

    // NTLMv2 key material
    var ntHash    = md4(utf16le(this.pass));                                   // NT hash
    var idBytes   = utf16le((this.user || '').toUpperCase() + (this.domain || ''));
    var ntlmv2Key = hmacMd5(ntHash, idBytes);

    // "temp" / NTLMv2 client blob
    var clientChallenge = crypto.randomBytes(8);
    var ts = findAvTimestamp(t2.targetInfo);
    if (!ts) { ts = Buffer.alloc(8, 0); }   // fall back to zero timestamp

    var blob = Buffer.concat([
        Buffer.from([0x01, 0x01, 0, 0, 0, 0, 0, 0]),  // RespType=1, HiRespType=1, Reserved
        ts,                                           // timestamp (FILETIME)
        clientChallenge,                              // 8 bytes
        Buffer.from([0, 0, 0, 0]),                    // Reserved
        t2.targetInfo,                                // server's AV pairs, echoed
        Buffer.from([0, 0, 0, 0])                     // Reserved
    ]);

    var ntProof = hmacMd5(ntlmv2Key, Buffer.concat([t2.challenge, blob]));
    var ntResp  = Buffer.concat([ntProof, blob]);
    var lmResp  = Buffer.concat([hmacMd5(ntlmv2Key, Buffer.concat([t2.challenge, clientChallenge])), clientChallenge]);
    var sessionKey = hmacMd5(ntlmv2Key, ntProof);   // no key-exchange → base key is it

    var domB = utf16le(this.domain);
    var userB = utf16le(this.user);
    var wsB   = utf16le('VLCTV');

    // Type3 fixed part = 64 bytes (no version), payload appended after.
    var fixed = 72;  // include 8-byte Version field (zeros) for compatibility
    var payloadOff = fixed;
    function field(len, off) { var f = Buffer.alloc(8); f.writeUInt16LE(len, 0); f.writeUInt16LE(len, 2); f.writeUInt32LE(off, 4); return f; }

    var parts = [];
    var cur = payloadOff;
    var lmOff = cur; cur += lmResp.length;
    var ntOff = cur; cur += ntResp.length;
    var domOff = cur; cur += domB.length;
    var userOff = cur; cur += userB.length;
    var wsOff = cur; cur += wsB.length;
    // EncryptedRandomSessionKey: empty

    var hdr = Buffer.alloc(fixed);
    hdr.write('NTLMSSP\0', 0, 'binary');
    hdr.writeUInt32LE(3, 8);                       // MessageType
    field(lmResp.length, lmOff).copy(hdr, 12);     // LmChallengeResponse
    field(ntResp.length, ntOff).copy(hdr, 20);     // NtChallengeResponse
    field(domB.length,  domOff).copy(hdr, 28);     // DomainName
    field(userB.length, userOff).copy(hdr, 36);    // UserName
    field(wsB.length,   wsOff).copy(hdr, 44);      // Workstation
    field(0,            cur).copy(hdr, 52);        // EncryptedRandomSessionKey (empty)
    hdr.writeUInt32LE(NTLM_F, 60);                 // NegotiateFlags
    // 64..71 Version = zeros

    var token = Buffer.concat([hdr, lmResp, ntResp, domB, userB, wsB]);
    return { token: token, sessionKey: sessionKey };
};

/* NTLMSSP type 3 for an anonymous (guest) logon: empty NT response, a single
 * zero LM byte, and the ANONYMOUS flag. No session key, so no signing. */
SmbConnection.prototype._buildAnonymousType3 = function () {
    var lmResp = Buffer.from([0x00]);   // Z(1) per MS-NLMP anonymous rule
    var ntResp = Buffer.alloc(0);
    var domB = Buffer.alloc(0), userB = Buffer.alloc(0), wsB = utf16le('VLCTV');
    var fixed = 72;
    function field(len, off) { var f = Buffer.alloc(8); f.writeUInt16LE(len, 0); f.writeUInt16LE(len, 2); f.writeUInt32LE(off, 4); return f; }
    var cur = fixed;
    var lmOff = cur; cur += lmResp.length;
    var ntOff = cur; cur += ntResp.length;
    var domOff = cur; cur += domB.length;
    var userOff = cur; cur += userB.length;
    var wsOff = cur; cur += wsB.length;

    var hdr = Buffer.alloc(fixed);
    hdr.write('NTLMSSP\0', 0, 'binary');
    hdr.writeUInt32LE(3, 8);
    field(lmResp.length, lmOff).copy(hdr, 12);
    field(ntResp.length, ntOff).copy(hdr, 20);
    field(domB.length,  domOff).copy(hdr, 28);
    field(userB.length, userOff).copy(hdr, 36);
    field(wsB.length,   wsOff).copy(hdr, 44);
    field(0,            cur).copy(hdr, 52);
    hdr.writeUInt32LE(NTLM_F | NTLM_ANON, 60);
    return { token: Buffer.concat([hdr, lmResp, ntResp, domB, userB, wsB]) };
};

SmbConnection.prototype._sessionSetupRequest = function (token, cb) {
    var body = Buffer.alloc(24 + token.length);
    body.writeUInt16LE(25, 0);                 // StructureSize
    body.writeUInt8(0, 2);                     // Flags
    body.writeUInt8(this.signing ? 0x02 : 0x01, 3); // SecurityMode
    body.writeUInt32LE(0, 4);                  // Capabilities
    body.writeUInt32LE(0, 8);                  // Channel
    body.writeUInt16LE(64 + 24, 12);           // SecurityBufferOffset (from header start)
    body.writeUInt16LE(token.length, 14);      // SecurityBufferLength
    writeU64LE(body, 16, 0);                   // PreviousSessionId
    token.copy(body, 24);
    this._send(SMB2.SESSION_SETUP, body, 1, cb);
};

SmbConnection.prototype._sessionSetup = function (done) {
    var self = this;
    // Round 1: type1
    this._sessionSetupRequest(ntlmType1(), function (status, hdr, resp) {
        if (status !== ST.MORE_PROCESSING)
            return done(new Error('SESSION_SETUP r1 unexpected 0x' + (status >>> 0).toString(16)));
        // Server assigns SessionId here; use it for every subsequent request.
        hdr.copy(self.sessionId, 0, 40, 48);
        var secOff = resp.readUInt16LE(2), secLen = resp.readUInt16LE(4);
        var challenge = resp.slice(secOff - 64, secOff - 64 + secLen);
        var t3;
        if (self.anonymous) {
            // Anonymous sessions have no key, so signing is off regardless of
            // what the server asked for (it'll simply reject if it insists).
            self.signing = false; self.signKey = null;
            t3 = self._buildAnonymousType3();
        } else {
            t3 = self._buildNtlmType3(challenge);
            // Signing key becomes available now; sign from the type3 request onward.
            self.signKey = t3.sessionKey;
        }
        self._sessionSetupRequest(t3.token, function (status2) {
            if (status2 !== ST.SUCCESS)
                return done(new Error('Authentication failed 0x' + (status2 >>> 0).toString(16)));
            log('SMB_AUTH_OK', { anonymous: self.anonymous });
            done(null);
        });
    });
};

SmbConnection.prototype._treeConnect = function (done) {
    var self = this;
    var unc = utf16le('\\\\' + this.host + '\\' + this.share);
    var body = Buffer.alloc(8 + unc.length);
    body.writeUInt16LE(9, 0);            // StructureSize
    body.writeUInt16LE(0, 2);            // Flags/Reserved
    body.writeUInt16LE(64 + 8, 4);       // PathOffset
    body.writeUInt16LE(unc.length, 6);   // PathLength
    unc.copy(body, 8);
    this._send(SMB2.TREE_CONNECT, body, 1, function (status, hdr) {
        if (status !== ST.SUCCESS) return done(new Error('TREE_CONNECT failed 0x' + (status >>> 0).toString(16)));
        self.treeId = hdr.readUInt32LE(36);
        log('SMB_TREE_OK', { share: self.share, treeId: self.treeId });
        done(null);
    });
};

/* Normalise an incoming /path into an SMB relative name (backslashes, no
 * leading slash). Empty → share root. */
function smbName(path) {
    var p = (path || '').replace(/^[\\/]+/, '').replace(/\//g, '\\');
    return p;
}

/* CREATE (open) — returns { fileId(Buffer16), size }. isDir picks the option. */
SmbConnection.prototype.open = function (path, isDir, cb) {
    var name = utf16le(smbName(path));
    var body = Buffer.alloc(56 + Math.max(name.length, 1));
    body.writeUInt16LE(57, 0);            // StructureSize (fixed 56 + 1 var)
    body.writeUInt8(0, 2);                // SecurityFlags
    body.writeUInt8(0, 3);                // RequestedOplockLevel
    body.writeUInt32LE(2, 4);             // ImpersonationLevel = Impersonation
    writeU64LE(body, 8, 0);               // SmbCreateFlags
    writeU64LE(body, 16, 0);              // Reserved
    body.writeUInt32LE(0x00100081, 24);   // DesiredAccess: READ_DATA|READ_ATTR|SYNCHRONIZE
    body.writeUInt32LE(0, 28);            // FileAttributes
    body.writeUInt32LE(0x00000007, 32);   // ShareAccess: READ|WRITE|DELETE
    body.writeUInt32LE(1, 36);            // CreateDisposition = FILE_OPEN
    body.writeUInt32LE(isDir ? 0x00000001 : 0x00000040, 40); // DIRECTORY_FILE / NON_DIRECTORY_FILE
    body.writeUInt16LE(64 + 56, 44);      // NameOffset
    body.writeUInt16LE(name.length, 46);  // NameLength
    body.writeUInt32LE(0, 48);            // CreateContextsOffset
    body.writeUInt32LE(0, 52);            // CreateContextsLength
    if (name.length) name.copy(body, 56);

    this._send(SMB2.CREATE, body, 1, function (status, hdr, resp) {
        if (status !== ST.SUCCESS) return cb(new Error('open "' + path + '" 0x' + (status >>> 0).toString(16)));
        var size   = readU64LE(resp, 48);        // EndOfFile
        var fileId = resp.slice(64, 80);         // 16-byte FileId
        cb(null, { fileId: fileId, size: size });
    });
};

SmbConnection.prototype.close = function (fileId, cb) {
    var body = Buffer.alloc(24);
    body.writeUInt16LE(24, 0);
    body.writeUInt16LE(0, 2);
    body.writeUInt32LE(0, 4);
    fileId.copy(body, 8);
    this._send(SMB2.CLOSE, body, 1, function () { cb && cb(); });
};

/* QUERY_DIRECTORY loop → array of { name, isDir, size }. */
SmbConnection.prototype.list = function (path, done) {
    var self = this;
    this.open(path, true, function (err, dir) {
        if (err) return done(err);
        var out = [];
        var pattern = utf16le('*');

        function round(restart) {
            var body = Buffer.alloc(32 + pattern.length);
            body.writeUInt16LE(33, 0);                  // StructureSize
            body.writeUInt8(0x01, 2);                   // FileInformationClass = FileDirectoryInformation
            body.writeUInt8(restart ? 0x01 : 0x00, 3);  // Flags: RESTART_SCANS on first call
            body.writeUInt32LE(0, 4);                   // FileIndex
            dir.fileId.copy(body, 8);                   // FileId
            body.writeUInt16LE(64 + 32, 24);            // FileNameOffset
            body.writeUInt16LE(pattern.length, 26);     // FileNameLength
            body.writeUInt32LE(0x10000, 28);            // OutputBufferLength (64 KiB)
            pattern.copy(body, 32);

            self._send(SMB2.QUERY_DIRECTORY, body, 1, function (status, hdr, resp) {
                if (status === ST.NO_MORE_FILES) { self.close(dir.fileId); return done(null, out); }
                if (status !== ST.SUCCESS) { self.close(dir.fileId); return done(new Error('list 0x' + (status >>> 0).toString(16))); }
                var bufOff = resp.readUInt16LE(2) - 64;
                var bufLen = resp.readUInt32LE(4);
                parseDirInfo(resp.slice(bufOff, bufOff + bufLen), out);
                round(false);
            });
        }
        round(true);
    });
};

/* Parse FileDirectoryInformation entries (info class 1). */
function parseDirInfo(buf, out) {
    var p = 0;
    while (p < buf.length) {
        var next   = buf.readUInt32LE(p);
        var endOf  = readU64LE(buf, p + 40);          // EndOfFile (size)
        var attrs  = buf.readUInt32LE(p + 56);        // FileAttributes
        var nameLn = buf.readUInt32LE(p + 60);
        var name   = buf.slice(p + 64, p + 64 + nameLn).toString('ucs2');
        if (name !== '.' && name !== '..') {
            out.push({ name: name, isDir: !!(attrs & 0x10), size: (attrs & 0x10) ? 0 : endOf });
        }
        if (next === 0) break;
        p += next;
    }
}

/* Single SMB2 READ at offset/length → Buffer (may be short, may be empty). */
SmbConnection.prototype.read = function (fileId, offset, length, cb) {
    var charge = Math.max(1, Math.ceil(length / 65536));
    var body = Buffer.alloc(49);
    body.writeUInt16LE(49, 0);            // StructureSize
    body.writeUInt8(0, 2);                // Padding
    body.writeUInt8(0, 3);                // Flags
    body.writeUInt32LE(length, 4);        // Length
    writeU64LE(body, 8, offset);          // Offset
    fileId.copy(body, 16);                // FileId
    body.writeUInt32LE(0, 32);            // MinimumCount
    body.writeUInt32LE(0, 36);            // Channel
    body.writeUInt32LE(0, 40);            // RemainingBytes
    body.writeUInt16LE(0, 44);            // ReadChannelInfoOffset
    body.writeUInt16LE(0, 46);            // ReadChannelInfoLength
    body.writeUInt8(0, 48);               // Buffer (1-byte pad)

    this._send(SMB2.READ, body, charge, function (status, hdr, resp) {
        if (status === ST.END_OF_FILE) return cb(null, Buffer.alloc(0));
        if (status !== ST.SUCCESS) return cb(new Error('read 0x' + (status >>> 0).toString(16)));
        var dataOff = resp.readUInt8(0) - 64;
        var dataLen = resp.readUInt32LE(4);
        cb(null, resp.slice(dataOff, dataOff + dataLen));
    });
};

/* ============================================================================
 * Connection registry — one live connection keyed by host|share. Re-used
 * across list/stream so we pay the negotiate/auth cost once.
 * ==========================================================================*/
var conns = {};
function connKey(o) { return (o.host || '') + '|' + (o.share || ''); }

function getConn(creds, cb) {
    var key = connKey(creds);
    var c = conns[key];
    if (c && !c.dead) return cb(null, c);
    c = new SmbConnection(creds);
    conns[key] = c;
    c.connect(function (err) {
        if (err) { delete conns[key]; return cb(err); }
        cb(null, c);
    });
}

/* The credentials of the most recent /smb/connect, so list/stream can omit
 * them. (Single active share for v1; multi-share is a small extension.) */
var lastCreds = null;

/* ============================================================================
 * HTTP surface
 * ==========================================================================*/
var CT = {
    mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    avi: 'video/x-msvideo', webm: 'video/webm', ts: 'video/mp2t', m2ts: 'video/mp2t',
    flv: 'video/x-flv', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
    mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
    ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/opus'
};
function contentType(path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    return CT[ext] || 'application/octet-stream';
}
function cors(res, code, type, extra) {
    var h = {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Allow-Private-Network': 'true',
        'Cache-Control': 'no-store'
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    res.writeHead(code, h);
}
function sendJson(res, code, obj) { cors(res, code, 'application/json'); res.end(JSON.stringify(obj)); }

function handleConnect(req, res) {
    var raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
        var creds;
        try { creds = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
        if (!creds.host || !creds.share) return sendJson(res, 400, { ok: false, error: 'host and share required' });
        // Drop any stale connection for this share so creds changes take effect.
        var key = connKey(creds);
        if (conns[key]) { try { conns[key]._die('reconnect'); } catch (e) {} delete conns[key]; }
        getConn(creds, function (err, c) {
            if (err) { log('CONNECT_FAIL', err.message); return sendJson(res, 502, { ok: false, error: err.message }); }
            lastCreds = creds;
            sendJson(res, 200, { ok: true, dialect: '0x' + c.dialect.toString(16), signing: c.signing });
        });
    });
}

function handleList(req, res, query) {
    if (!lastCreds) return sendJson(res, 409, { ok: false, error: 'not connected' });
    var path = query.path || '';
    getConn(lastCreds, function (err, c) {
        if (err) return sendJson(res, 502, { ok: false, error: err.message });
        c.list(path, function (e2, entries) {
            if (e2) return sendJson(res, 502, { ok: false, error: e2.message });
            entries.sort(function (a, b) {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
            });
            sendJson(res, 200, { ok: true, path: path, entries: entries });
        });
    });
}

var READ_CHUNK = 256 * 1024;   // per SMB2 READ; CreditCharge ≤ 4

function handleStream(req, res, query) {
    if (!lastCreds) { cors(res, 409, 'text/plain'); return res.end('not connected'); }
    var path = query.path || '';
    getConn(lastCreds, function (err, c) {
        if (err) { cors(res, 502, 'text/plain'); return res.end(err.message); }
        c.open(path, false, function (e2, file) {
            if (e2) { cors(res, 404, 'text/plain'); return res.end(e2.message); }
            var size = file.size;

            // Parse Range: bytes=start-end
            var start = 0, end = size - 1, partial = false;
            var range = req.headers.range;
            if (range) {
                var m = /bytes=(\d*)-(\d*)/.exec(range);
                if (m) {
                    partial = true;
                    if (m[1] !== '') start = parseInt(m[1], 10);
                    if (m[2] !== '') end   = parseInt(m[2], 10);
                    if (m[1] === '' && m[2] !== '') { start = size - parseInt(m[2], 10); end = size - 1; } // suffix range
                }
            }
            if (start > end || start >= size) {
                c.close(file.fileId);
                cors(res, 416, 'text/plain', { 'Content-Range': 'bytes */' + size });
                return res.end();
            }
            var length = end - start + 1;
            var headers = {
                'Accept-Ranges': 'bytes',
                'Content-Length': String(length),
                'Content-Type': contentType(path)
            };
            if (partial) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
            cors(res, partial ? 206 : 200, headers['Content-Type'], headers);

            var pos = start, remaining = length, aborted = false;
            req.on('close', function () { aborted = true; });

            function pump() {
                if (aborted || remaining <= 0) { c.close(file.fileId); if (!aborted) res.end(); return; }
                var want = Math.min(READ_CHUNK, remaining);
                c.read(file.fileId, pos, want, function (re, data) {
                    if (aborted) { c.close(file.fileId); return; }
                    if (re)            { c.close(file.fileId); try { res.end(); } catch (e) {} return; }
                    if (!data.length)  { c.close(file.fileId); res.end(); return; } // hit EOF early
                    pos += data.length; remaining -= data.length;
                    var ok = res.write(data);
                    if (ok) pump();
                    else res.once('drain', pump);   // respect backpressure
                });
            }
            pump();
        });
    });
}

var server = http.createServer(function (req, res) {
    var u = require('url').parse(req.url, true);
    if (req.method === 'OPTIONS') { cors(res, 204, 'text/plain'); return res.end(); }

    if (u.pathname === '/smb/ping')        return sendJson(res, 200, { ok: true });
    if (u.pathname === '/smb/debug/logs')  return sendJson(res, 200, { logs: LOGS });
    if (u.pathname === '/smb/connect' && req.method === 'POST') return handleConnect(req, res);
    if (u.pathname === '/smb/list')        return handleList(req, res, u.query);
    if (u.pathname === '/smb/stream')      return handleStream(req, res, u.query);

    cors(res, 404, 'text/plain'); res.end('Not Found');
});

server.listen(PORT, LISTEN_HOST, function () { log('SMB_PROXY_LISTENING', LISTEN_HOST + ':' + PORT); });

process.on('uncaughtException', function (e) { log('UNCAUGHT', e && e.message); });
