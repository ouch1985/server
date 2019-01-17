import { Agent } from 'http';
import net from 'net';
import assert from 'assert';
import log from 'book';
import Debug from 'debug';

const DEFAULT_MAX_SOCKETS = 10;

const ports = (function(){
    let arr = [];
    for(let i=8802;i<8820;i++){
        arr.push({
            port: i,
            used: false
        });
    }

    return {
        index: 0,
        arr: arr
    }
})();

function nextPort(debug){
    let count = 0;
    let port = null;
    while(count < ports.arr.length){
        let item = ports.arr[ports.index];
        ports.index++;
        if(ports.index >= ports.arr.length){
            ports.index = 0;
        }
        if(!item.used){
            port = item.port;
            item.used = true;

            console.log('占用端口', port);
            debug('占用端口 %d', port);

            break;
        }
        count++;
    }

    if(!port){
        console.log('端口不够用了');
        debug('端口不够用了');
    }
    return port;
}

function freePort(debug, port){
    for(let item of ports.arr){
        if(item.port === port){
            item.used = true;
            console.log('释放端口', port);
            debug('端口不够用了 %d', port);
            break;
        }
    }
}

// Implements an http.Agent interface to a pool of tunnel sockets
// A tunnel socket is a connection _from_ a client that will
// service http requests. This agent is usable wherever one can use an http.Agent
class TunnelAgent extends Agent {
    constructor(options = {}) {
        super({
            keepAlive: true,
            // only allow keepalive to hold on to one socket
            // this prevents it from holding on to all the sockets so they can be used for upgrades
            maxFreeSockets: 1,
        });

        // sockets we can hand out via createConnection
        this.availableSockets = [];

        // when a createConnection cannot return a socket, it goes into a queue
        // once a socket is available it is handed out to the next callback
        this.waitingCreateConn = [];

        this.debug = Debug(`lt:TunnelAgent[${options.clientId}]`);

        // track maximum allowed sockets
        this.connectedSockets = 0;
        this.maxTcpSockets = options.maxTcpSockets || DEFAULT_MAX_SOCKETS;

        // new tcp server to service requests for this client
        this.server = net.createServer();

        // flag to avoid double starts
        this.started = false;
        this.closed = false;
    }

    stats() {
        return {
            connectedSockets: this.connectedSockets,
        };
    }

    listen() {
        const server = this.server;
        if (this.started) {
            throw new Error('already started');
        }
        this.started = true;

        server.on('close', this._onClose.bind(this));
        server.on('connection', this._onConnection.bind(this));
        server.on('error', (err) => {
            // These errors happen from killed connections, we don't worry about them
            if (err.code == 'ECONNRESET' || err.code == 'ETIMEDOUT') {
                return;
            }
            log.error(err);
        });

        return new Promise((resolve) => {
            this.__port = nextPort();
            server.listen(this.__port, () => {
                const port = server.address().port;
                this.debug('tcp server listening on port: %d', port);

                resolve({
                    // port for lt client tcp connections
                    port: port,
                });
            });
        });
    }

    _onClose() {
        this.closed = true;
        this.debug('closed tcp socket');
        // flush any waiting connections
        for (const conn of this.waitingCreateConn) {
            conn(new Error('closed'), null);
        }
        this.waitingCreateConn = [];
        freePort(this.debug, this.__port);
        this.emit('end');
    }

    // new socket connection from client for tunneling requests to client
    _onConnection(socket) {
        // no more socket connections allowed
        if (this.connectedSockets >= this.maxTcpSockets) {
            this.debug('no more sockets allowed');
            socket.destroy();
            return false;
        }

        socket.once('close', (hadError) => {
            this.debug('closed socket (error: %s)', hadError);
            this.connectedSockets -= 1;
            // remove the socket from available list
            const idx = this.availableSockets.indexOf(socket);
            if (idx >= 0) {
                this.availableSockets.splice(idx, 1);
            }

            this.debug('connected sockets: %s', this.connectedSockets);
            if (this.connectedSockets <= 0) {
                this.debug('all sockets disconnected');
                this.emit('offline');
            }

            freePort(this.debug, this.__port);
        });

        // close will be emitted after this
        socket.once('error', (err) => {
            // we do not log these errors, sessions can drop from clients for many reasons
            // these are not actionable errors for our server
            socket.destroy();
            freePort(this.debug, this.__port);
        });

        if (this.connectedSockets === 0) {
            this.emit('online');
        }

        this.connectedSockets += 1;
        this.debug('new connection from: %s:%s', socket.address().address, socket.address().port);

        // if there are queued callbacks, give this socket now and don't queue into available
        const fn = this.waitingCreateConn.shift();
        if (fn) {
            this.debug('giving socket to queued conn request');
            setTimeout(() => {
                fn(null, socket);
            }, 0);
            return;
        }

        // make socket available for those waiting on sockets
        this.availableSockets.push(socket);
    }

    // fetch a socket from the available socket pool for the agent
    // if no socket is available, queue
    // cb(err, socket)
    createConnection(options, cb) {
        if (this.closed) {
            cb(new Error('closed'));
            return;
        }

        this.debug('create connection');

        // socket is a tcp connection back to the user hosting the site
        const sock = this.availableSockets.shift();

        // no available sockets
        // wait until we have one
        if (!sock) {
            this.waitingCreateConn.push(cb);
            this.debug('waiting connected: %s', this.connectedSockets);
            this.debug('waiting available: %s', this.availableSockets.length);
            return;
        }

        this.debug('socket given');
        cb(null, sock);
    }

    destroy() {
        this.server.close();
        super.destroy();
        freePort(this.debug, this.__port);
    }
}

export default TunnelAgent;
