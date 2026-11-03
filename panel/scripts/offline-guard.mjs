// Packaging verification guard. No test may perform outbound network I/O.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('Network disabled for synthetic package verification');};
globalThis.fetch=blocked;
net.Socket.prototype.connect=blocked;
http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;
dgram.createSocket=blocked;
syncBuiltinESMExports();
