"use strict";

var xmpp = require('node-xmpp-client');
var Events = require('events').EventEmitter;
var crypto = require('crypto');

module.exports = function GCMClient(projectId, apiKey) {
	var events = new Events();
	var draining = true;
	var queued = [];
	var acks = [];

	var client = new xmpp.Client({
		jid: projectId + '@gcm.googleapis.com',
		password: apiKey,
		port: 5235,
		host: 'gcm.googleapis.com',
		legacySSL: true,
		preferredSaslMechanism : 'PLAIN'
	});

	client.connection.socket.setTimeout(0);
	client.connection.socket.setKeepAlive(true, 10000);

	function _send(json) {
		if (draining) {
			console.log("[node-gcm-ccs][_send] draining is on! queueing json...:", JSON.parse(json));
			queued.push(json);
		} else {
			var message = new xmpp.Stanza.Element('message').c('gcm', { xmlns: 'google:mobile:data' }).t(JSON.stringify(json));
			client.send(message);
		}
	}

	client.on('online', function() {
		console.log("[node-gcm-ccs][client][online] GCM server is online");
		events.emit('connected');

		if (draining) {
			draining = false;
			var i = queued.length;
			console.log("[node-gcm-ccs][client][online] need to draining. queue size:", i, "queue:", JSON.stringify(queued));
			while (i--) {
				_send(queued[i]);
			}
			queued = [];
		}
	});

	client.on('close', function() {
		console.log("[node-gcm-ccs][client][close] draining:", draining);
		if (draining) {
			client.connect();
		} else {
			events.emit('disconnected');
		}
	});

	client.on('error', function(e) {
		events.emit('error', e);
	});

	client.on('stanza', function(stanza) {
		if (stanza.is('message') && stanza.attrs.type !== 'error') {
			var data = JSON.parse(stanza.getChildText('gcm'));

			console.log("[node-gcm-ccs][client][stanza] message is coming: ");
			if (!data || !data.message_id) {
				console.log("[node-gcm-ccs][client][stanza] wrong data: ", data);
				return;
			}

			switch (data.message_type) {
				case 'control':
					console.log("[node-gcm-ccs][client][stanza][control] wrong data: ", JSON.stringify(data));
					if (data.control_type === 'CONNECTION_DRAINING') {
						draining = true;
					}
					break;

				case 'nack':
					console.log("[node-gcm-ccs][client][stanza][nack] iterate over acks: ", JSON.stringify(acks));
					if (data.message_id in acks) {
						acks[data.message_id](data.error);
						delete acks[data.message_id];
					}
					break;

				case 'ack':
					console.log("[node-gcm-ccs][client][stanza][ack] iterate over acks: ", JSON.stringify(acks));
					if (data.message_id in acks) {
						acks[data.message_id](undefined, data.message_id, data.from);
						delete acks[data.message_id];
					}
					break;

				case 'receipt':
					console.log("[node-gcm-ccs][client][stanza][receipt] messageId:", data.message_id);
					events.emit('receipt', data.message_id, data.from, data.category, data.data);
					break;

				default:
					console.log("[node-gcm-ccs][client][stanza][default] data:", JSON.stringify(data));
					// Send ack, as per spec
					if (data.from) {
						_send({
							to: data.from,
							message_id: data.message_id,
							message_type: 'ack'
						});

						if (data.data) {
							events.emit('message', data.message_id, data.from, data.category, data.data);
						}
					}

					break;
			}
		} else {
			var message = stanza.getChildText('error').getChildText('text');
			console.log("[node-gcm-ccs][client][stanza] error is coming: ", JSON.stringify(message));
			events.emit('message-error', message);
		}
	});

	function send(to, data, options, cb) {
		var messageId = crypto.randomBytes(8).toString('hex');

		var outData = {
			to: to,
			message_id: messageId,
			data: data
		};
		Object.keys(options).forEach(function(option) {
			outData[option] = options[option];
		});

		if (cb !== undefined) {
			acks[messageId] = cb;
		}

		_send(outData);
	}

	function end() {
		console.log("[node-gcm-ccs][client][end] ending client.. ");
		client.end();
	}

	function isReady() {
		console.log("[node-gcm-ccs][isReady] Object.keys(acks).length: ", Object.keys(acks).length, "isReady", Object.keys(acks).length <= 100);
		return Object.keys(acks).length <=100;
	}

	events.end = end;
	events.send = send;
	events.isReady= isReady;
	return events;
};
