"use strict";


global.crypto = require('crypto').webcrypto;
global.Olm = require("olm");
const sdk = require("matrix-js-sdk");
const { LocalStorage } = require('node-localstorage');
const { LocalStorageCryptoStore } = require('matrix-js-sdk/lib/crypto/store/localStorage-crypto-store');
//const { decryptMegolmKeyFile } = require('./megolm-utils.js');
const crypto = require('crypto');

module.exports = function(RED) {

// --------------------------------------------------------------------------------------------
	// The configuration node holds the configuration and credentials for all nodes.

	function MatrixBotNode(config) {
		RED.nodes.createNode(this, config);

		// This is a constructor and cannot be async, so wrap in an async IIFE
		(async () => {
			// copy "this" object in case we need it in context of callbacks of other functions.
			var node = this;

			node.log("Initializing Matrix Bot node");

			// Configuration options passed by Node Red
			node.userId = config.userId;
			node.accessToken = config.accessToken;
			node.room = config.room;
			node.keys = config.keys;
			node.passphrase = config.passphrase;
			node.e2ee = node.keys && node.passphrase;
			node.deviceId = config.deviceId;

			// TODO: Switch from configuration to credentials and check with if (this.credentials)
			node.matrixServerURL = config.matrixServerURL;

			const localStorage = new LocalStorage('./store-' + crypto.createHash('md5').update(node.userId, 'utf8').digest('hex'));

			let keys;

			node.matrixClient = sdk.createClient({
				baseUrl: node.matrixServerURL,
				accessToken: node.accessToken,
				userId: node.userId,
				deviceId: node.deviceId,
				sessionStore: new sdk.WebStorageSessionStore(localStorage),
				cryptoStore: new LocalStorageCryptoStore(localStorage),
				cryptoCallbacks: {
					saveCrossSigningKeys: k => keys = k,
					getCrossSigningKey: typ => keys[typ],
					getSecretStorageKey: async request => {
						console.log('aaaaaaaaaaa', node.privateKey, keys);
						return [ Object.keys(request.keys)[0], node.privateKey ];
					},
				},
			});

			//const res = await node.matrixClient.login('m.login.password', { user: node.userId, password: node.passphrase, initial_device_display_name: 'Node-RED' });

			//node.log(JSON.stringify(res));

			//node.matrixClient.deviceId = res.device_id;


			// If no room is specified, join any room where we are invited
			if (!node.room || node.room === "") {
				node.matrixClient.on("RoomMember.membership", function(event, member) {
					if (member.membership === "invite" && member.userId === node.userId) {
						node.log("Trying to join room " + member.roomId);
						node.matrixClient.joinRoom(member.roomId).then(function() {
							node.log("Automatically accepted invitation to join room " + member.roomId);
						}).catch(function(e) {
							node.warn("Cannot join room (probably because I was kicked) " + member.roomId + ": " + e);
						});
					}
				});
			}

			node.matrixClient.onDecryptedMessage = message => {
				console.log('Got encrypted message: ', message);
			}

			node.matrixClient.on('Event.decrypted', (event) => {
				if (event.getType() === 'm.room.message'){
					node.matrixClient.onDecryptedMessage(event.getContent().body);
				} else {
					console.log('decrypted an event of type', event.getType());
					console.log(event);
				}
			});

			node.matrixClient.on("sync", function(state, prevState, data) {
				switch (state) {
					case "ERROR":
						// update UI to say "Connection Lost"
						node.warn("Connection to Matrix server lost");
						node.updateConnectionState(false);
						break;
					case "SYNCING":
						// update UI to remove any "Connection Lost" message
						node.updateConnectionState(true);
						break;
					case "PREPARED":
						// the client instance is ready to be queried.
						node.log("Synchronized to Matrix server.");

						if (node.room) {
							node.log("Trying to join room " + node.room);

							node.matrixClient.joinRoom(node.room, {syncRoom:false})
								.then(function(joinedRoom) {
									node.log("Joined " + node.room);
									node.room = joinedRoom.roomId;
									node.updateConnectionState(true);
								}).catch(function(e) {
									node.warn("Error joining " + node.room + ": " + e);
								});
						} else {
							node.log("No room configured. Will only join rooms where I'm invited");
						}
						break;
				}
			});

			node.log("Connecting to Matrix server...");

			if (node.e2ee) {
				await node.matrixClient.initCrypto();
				try {
					let aa;
					//const { backupInfo } = aa = await node.matrixClient.checkKeyBackup();
					const backupInfo = await node.matrixClient.getKeyBackupVersion();
					const has4S = await node.matrixClient.hasSecretStorageKey();
					const backupKeyStored = has4S && await node.matrixClient.isKeyBackupKeyStored();

					const backupHasPassphrase = (
						backupInfo &&
						backupInfo.auth_data &&
						backupInfo.auth_data.private_key_salt &&
						backupInfo.auth_data.private_key_iterations
					);

					node.log('################');
					console.log(backupHasPassphrase, backupInfo);
					if (backupInfo) {
						// A complete restore can take many minutes for large
						// accounts / slow servers, so we allow the dialog
						// to advance before this.
						//const recoverInfo = await node.matrixClient.restoreKeyBackupWithPassword(node.passphrase, undefined, undefined, backupInfo);
						const recoverInfo = await node.matrixClient.restoreKeyBackupWithSecretStorage(backupInfo);
						console.log(recoverInfo);
					}
				} catch (e) {
					node.log('xxxxxxxxxxxxxxxxx');
					console.error(e);

				}
			}

			await node.matrixClient.startClient({ initialSyncLimit: 1 });
			//await node.matrixClient.startClient();

			// Called when the connection state may have changed
			this.updateConnectionState = function(connected){
				if (node.connected !== connected) {
					node.connected = connected;
					if (connected) {
						node.emit("connected", node.e2ee);
					} else {
						node.emit("disconnected");
					}
				}
			};

			// When Node-RED updates nodes, disconnect from server to ensure a clean start
			node.on("close", function (done) {
				node.log("Matrix configuration node closing...");
				if (node.matrixClient) {
					node.log("Disconnecting from Matrix server...");
					//node.matrixClient.logout().then(() => {
						node.matrixClient.stopClient();
						node.updateConnectionState(false);
					//}).catch(done);
				} else {
					done();
				}
			});

		})();
	}

	RED.nodes.registerType("matrix bot", MatrixBotNode);

// --------------------------------------------------------------------------------------------
	// The output node sends a message to the chat.

	function MatrixOutNode(config) {
		RED.nodes.createNode(this, config);

		// copy "this" object in case we need it in context of callbacks of other functions.
		var node = this;
        
        // Configuration options passed by Node Red
        node.configNode = RED.nodes.getNode(config.bot);

        node.configNode.on("connected", function(e2ee){
        	node.status({ fill: "green", shape: "ring", text: "connected" + (e2ee ? ' (E2EE)' : '') });
        });

        node.configNode.on("disconnected", function(e2ee){
        	node.status({ fill: "red", shape: "ring", text: "disconnected" });
        });

        this.on("input", function (msg) {
        	if (! node.configNode || ! node.configNode.matrixClient) {
            	node.warn("No configuration");
            	return;
        	}

            if (msg.payload) {
	        	node.log("Sending message " + msg.payload);

	        	var destRoom = "";
	        	if (msg.roomId) {
	        		destRoom = msg.roomId;
	        	} else if (node.configNode.room) {
	        		destRoom = node.configNode.room;
	        	} else {
	        		node.warn("Room must be specified in msg.roomId or in configuration");
	        		return;
	        	}

	        	if(msg.payload.type && msg.payload.type == 'image'){
	        		node.configNode.matrixClient.uploadContent(msg.payload.content, { rawResponse: msg.payload.raw, type: msg.payload.imgType }).then(function(file){
						node.configNode.matrixClient.sendImageMessage(destRoom, file.content_uri, {}, msg.payload.text).then(function(imgResp) {
							node.log("Message sent: " + imgResp);
						}).catch(function(e){
							node.warn("Error sending image message " + e);
						});
					}).catch(function(e){
						node.warn("Error uploading image message " + e);
					});
				}
				else {
					node.configNode.matrixClient.sendTextMessage(destRoom, msg.payload.toString())
						.then(function() {
							node.log("Message sent: " + msg.payload);
						}).catch(function(e){
							node.warn("Error sending message " + e);
						});
				}
	        } else {
                node.warn("msg.payload is empty");
            }
    	});

    	this.on("close", function(done) {
    		node.log("Matrix out node closing...");
    		done();
    	});
    }

	RED.nodes.registerType("matrix sender", MatrixOutNode);


// --------------------------------------------------------------------------------------------
	// The input node receives messages from the chat.

	function MatrixInNode(config) {
		RED.nodes.createNode(this, config);

		// copy "this" object in case we need it in context of callbacks of other functions.
		var node = this;
        node.configNode = RED.nodes.getNode(config.bot);

        node.log("MatrixInNode initializing...");

        if (!node.configNode) {
        	node.warn("No configuration node");
        	return;
        }

        node.status({ fill: "red", shape: "ring", text: "disconnected" });

        node.configNode.on("disconnected", function(){
        	node.status({ fill: "red", shape: "ring", text: "disconnected" });
        });

		node.configNode.on("connected", function(e2ee) {
			node.status({ fill: "green", shape: "ring", text: "connected" + (e2ee ? ' (E2EE)' : '')});
			node.configNode.matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline, data) {
				if (toStartOfTimeline) {
					return; // don't print paginated results
				}
				if (event.getType() !== "m.room.message") {
					return; // only keep messages
				}
				if (!event.getSender() || event.getSender() === node.configNode.userId) {
					return; // ignore our own messages
				}
				if (!event.getUnsigned() || event.getUnsigned().age > 1000) {
					return; // ignore old messages
				}
				// TODO process messages other than text
				node.log(
					// the room name will update with m.room.name events automatically
					"Received chat message: (" + room.name + ") " + event.getSender() + " :: " + event.getContent().body
				);
				var msg = {
					payload: event.getContent().body,
					sender: event.getSender(),
					roomId: room.roomId
				};
				node.send(msg);
			});
		});

    	this.on("close", function(done) {
    		node.log("Matrix in node closing...");
    		done();
    	});

	}

	RED.nodes.registerType("matrix receiver", MatrixInNode);

// --------------------------------------------------------------------------------------------
	// The command node receives messages from the chat.

	function MatrixCommandNode(config) {
		RED.nodes.createNode(this, config);

		// copy "this" object in case we need it in context of callbacks of other functions.
		var node = this;
		node.command = config.command;
        node.configNode = RED.nodes.getNode(config.bot);

        node.log("MatrixCommandNode initializing...");

        if (!node.configNode) {
        	node.warn("No configuration node");
        	return;
        }

        node.status({ fill: "red", shape: "ring", text: "disconnected" });

        node.configNode.on("disconnected", function(){
        	node.status({ fill: "red", shape: "ring", text: "disconnected" });
        });

		node.configNode.on("connected", function(e2ee) {
			node.status({ fill: "green", shape: "ring", text: "connected" + (e2ee ? ' (E2EE)' : '') });
			node.configNode.matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline, data) {
				if (toStartOfTimeline) {
					return; // don't print paginated results
				}
				if (event.getType() !== "m.room.message") {
					return; // only keep messages
				}
				if (!event.getSender() || event.getSender() === node.configNode.userId) {
					return; // ignore our own messages
				}
				if (!event.getUnsigned() || event.getUnsigned().age > 1000) {
					return; // ignore old messages
				}
				// TODO process messages other than text
				node.log(
					// the room name will update with m.room.name events automatically
					"Received chat message: (" + room.name + ") " + event.getSender() + " :: " + event.getContent().body
				);

				var message = event.getContent().body;

				var tokens = message.split(" ");

				if (tokens[0] == node.command) {
					node.log("Recognized command " + node.command + "  Processing...");
					var remainingText = message.replace(node.command, "");
                    var msg = {
                    	payload: remainingText, 
						sender: event.getSender(),
						roomId: room.roomId,
						originalMessage: message
                    };
                    node.send([msg, null]);
				}

			});
		});

    	this.on("close", function(done) {
    		node.log("Matrix command node closing...");
    		done();
    	});
	}

	RED.nodes.registerType("matrix command", MatrixCommandNode);

}
