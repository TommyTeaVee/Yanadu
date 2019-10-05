
/**
 * webRTC namespace.
 */
if (typeof webRTC == "undefined") {
    webRTC = {

        /** CONFIG **/
        SIGNALING_SERVER: "wss://" + window.location.hostname + ":" + window.location.port,
        USE_AUDIO: true,
        USE_VIDEO: true,
        DEFAULT_CHANNEL: 'some-global-channel-name',
        MUTE_AUDIO_BY_DEFAULT: false,

        /** You should probably use a different stun server doing commercial stuff **/
        /** Also see: https://gist.github.com/zziuni/3741933 **/
        ICE_SERVERS: [
            { url: "stun:stun.l.google.com:19302" }
        ],


        signaling_socket: null,   /* our socket.io connection to our webserver */
        local_media_stream: null, /* our own microphone / webcam */
        peers: {},                /* keep track of our peer connections, indexed by peer_id (aka socket.io id) */
        peer_media_elements: {},  /* keep track of our <video>/<audio> tags, indexed by peer_id */
        guidGenerator: function () {
            var S4 = function () {
                return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
            };
            return (S4() + S4() + "-" + S4() + "-" + S4() + "-" + S4() + "-" + S4() + S4() + S4());
        },
        init: function () {
            console.log("Connecting to signaling server");
            webRTC.signaling_socket = new WebSocket(webRTC.SIGNALING_SERVER);

            webRTC.signaling_socket.onopen = function () {
                console.log("Connected to the signaling server");
                webRTC.setup_local_media(function () {
                    /* once the user has given us access to their
                     * microphone/camcorder, join the channel and start peering up */
                    webRTC.join_chat_channel(webRTC.DEFAULT_CHANNEL, { 'whatever-you-want-here': 'stuff' });
                });
            };

            webRTC.signaling_socket.onclose = function (event) {
                console.log("Disconnected from signaling server");
                /* Tear down all of our peer connections and remove all the
                 * media divs when we disconnect */
                for (peer_id in webRTC.peer_media_elements) {
                    webRTC.peer_media_elements[peer_id].remove();
                }
                for (peer_id in webRTC.peers) {
                    webRTC.peers[peer_id].close();
                }

                webRTC.peers = {};
                webRTC.peer_media_elements = {};
            };

            //when we got a message from a signaling server 
            webRTC.signaling_socket.onmessage = function (msg) {
                console.log("Got message", msg.data);
                var data = JSON.parse(msg.data);

                switch (data.type) {
                    case "addPeer":
                        webRTC.do_addPeer(data.config);
                        break;
                    case "sessionDescription":
                        webRTC.do_sessionDescription(data.config);
                        break;
                    case "iceCandidate":
                        webRTC.do_iceCandidate(data.config);
                        break;
                    case "removePeer":
                        webRTC.do_removePeer(data.config);
                        break;
                    default:
                        break;
                }
            };

            webRTC.signaling_socket.onerror = function (err) {
                console.log("Got error", err);
            };


        },

            /** 
            * When we join a group, our signaling server will send out 'addPeer' events to each pair
            * of users in the group (creating a fully-connected graph of users, ie if there are 6 people
            * in the channel you will connect directly to the other 5, so there will be a total of 15 
            * connections in the network). 
            */
           do_addPeer: function (config) {
            console.log('Signaling server said to add peer:', config);
            var peer_id = config.peer_id;
            if (peer_id in webRTC.peers) {
                /* This could happen if the user joins multiple channels where the other peer is also in. */
                console.log("Already connected to peer ", peer_id);
                return;
            }
            var peer_connection = new RTCPeerConnection(
                { "iceServers": webRTC.ICE_SERVERS },
                { "optional": [{ "DtlsSrtpKeyAgreement": true }] } /* this will no longer be needed by chrome
                                                        * eventually (supposedly), but is necessary 
                                                        * for now to get firefox to talk to chrome */
            );
            webRTC.peers[peer_id] = peer_connection;

            peer_connection.onicecandidate = function (event) {
                if (event.candidate) {
                    webRTC.emit('relayICECandidate', {
                        'peer_id': peer_id,
                        'ice_candidate': {
                            'sdpMLineIndex': event.candidate.sdpMLineIndex,
                            'candidate': event.candidate.candidate
                        }
                    });
                }
            }
            peer_connection.onaddstream = function (event) {
                console.log("onAddStream", event);
                var remote_media = webRTC.USE_VIDEO ? $("<video>") : $("<audio>");
                remote_media.attr("autoplay", "autoplay");
                if (webRTC.MUTE_AUDIO_BY_DEFAULT) {
                    remote_media.attr("muted", "true");
                }
                remote_media.attr("controls", "");
                webRTC.peer_media_elements[peer_id] = remote_media;
                $('body').append(remote_media);
                webRTC.attachMediaStream(remote_media[0], event.stream);
            }

            /* Add our local stream */
            peer_connection.addStream(webRTC.local_media_stream);

            /* Only one side of the peer connection should create the
             * offer, the signaling server picks one to be the offerer. 
             * The other user will get a 'sessionDescription' event and will
             * create an offer, then send back an answer 'sessionDescription' to us
             */
            if (config.should_create_offer) {
                console.log("Creating RTC offer to ", peer_id);
                peer_connection.createOffer(
                    function (local_description) {
                        console.log("Local offer description is: ", local_description);
                        peer_connection.setLocalDescription(local_description,
                            function () {
                                webRTC.emit('relaySessionDescription',
                                    { 'peer_id': peer_id, 'session_description': local_description });
                                console.log("Offer setLocalDescription succeeded");
                            },
                            function () { Alert("Offer setLocalDescription failed!"); }
                        );
                    },
                    function (error) {
                        console.log("Error sending offer: ", error);
                    });
            }
        },


        /** 
         * Peers exchange session descriptions which contains information
         * about their audio / video settings and that sort of stuff. First
         * the 'offerer' sends a description to the 'answerer' (with type
         * "offer"), then the answerer sends one back (with type "answer").  
         */
        do_sessionDescription: function (config) {
            console.log('Remote description received: ', config);
            var peer_id = config.peer_id;
            var peer = webRTC.peers[peer_id];
            var remote_description = config.session_description;
            console.log(config.session_description);

            var desc = new RTCSessionDescription(remote_description);
            var stuff = peer.setRemoteDescription(desc,
                function () {
                    console.log("setRemoteDescription succeeded");
                    if (remote_description.type == "offer") {
                        console.log("Creating answer");
                        peer.createAnswer(
                            function (local_description) {
                                console.log("Answer description is: ", local_description);
                                peer.setLocalDescription(local_description,
                                    function () {
                                        webRTC.emit('relaySessionDescription',
                                            { 'peer_id': peer_id, 'session_description': local_description });
                                        console.log("Answer setLocalDescription succeeded");
                                    },
                                    function () { Alert("Answer setLocalDescription failed!"); }
                                );
                            },
                            function (error) {
                                console.log("Error creating answer: ", error);
                                console.log(peer);
                            });
                    }
                },
                function (error) {
                    console.log("setRemoteDescription error: ", error);
                }
            );
            console.log("Description Object: ", desc);

        },

        /**
         * The offerer will send a number of ICE Candidate blobs to the answerer so they 
         * can begin trying to find the best path to one another on the net.
         */
        do_iceCandidate: function (config) {
            var peer = webRTC.peers[config.peer_id];
            var ice_candidate = config.ice_candidate;
            peer.addIceCandidate(new RTCIceCandidate(ice_candidate));
        },


        /**
         * When a user leaves a channel (or is disconnected from the
         * signaling server) everyone will recieve a 'removePeer' message
         * telling them to trash the media channels they have open for those
         * that peer. If it was this client that left a channel, they'll also
         * receive the removePeers. If this client was disconnected, they
         * wont receive removePeers, but rather the
         * function do_disconnect') code will kick in and tear down
         * all the peer sessions.
         */
        do_removePeer: function (config) {
            console.log('Signaling server said to remove peer:', config);
            var peer_id = config.peer_id;
            if (peer_id in webRTC.peer_media_elements) {
                webRTC.peer_media_elements[peer_id].remove();
            }
            if (peer_id in webRTC.peers) {
                webRTC.peers[peer_id].close();
            }

            delete webRTC.peers[peer_id];
            delete webRTC.peer_media_elements[config.peer_id];
        },

        //alias for sending JSON encoded messages 
        emit: function (type, config) {
            //attach the other peer username to our messages 
            message = { 'type': type, 'config': config }

            webRTC.signaling_socket.send(JSON.stringify(message));
        },

        join_chat_channel: function (channel, userdata) {
            webRTC.emit('join', { "channel": channel, "name": webRTC.guidGenerator(), "userdata": userdata });
        },
        part_chat_channel: function (channel) {
            webRTC.emit('part', channel);
        },


        /***********************/
        /** Local media stuff **/
        /***********************/
        setup_local_media: function (callback, errorback) {
            if (webRTC.local_media_stream != null) {  /* ie, if we've already been initialized */
                if (callback) callback();
                return;
            }
            /* Ask user for permission to use the computers microphone and/or camera, 
             * attach it to an <audio> or <video> tag if they give us access. */
            console.log("Requesting access to local audio / video inputs");


            navigator.getUserMedia = (navigator.getUserMedia ||
                navigator.webkitGetUserMedia ||
                navigator.mozGetUserMedia ||
                navigator.msGetUserMedia);

            webRTC.attachMediaStream = function (element, stream) {
                console.log('DEPRECATED, attachMediaStream will soon be removed.');
                element.srcObject = stream;
            };

            /*   This is the original version ****************
           navigator.getUserMedia({"audio":USE_AUDIO, "video":USE_VIDEO},
               function(stream) { // user accepted access to a/v 
                   console.log("Access granted to audio/video");
                   local_media_stream = stream;
                   var local_media = USE_VIDEO ? $("<video>") : $("<audio>");
                   local_media.attr("autoplay", "autoplay");
                   local_media.attr("muted", "true"); // always mute ourselves by default 
                   local_media.attr("controls", "");
                   $('body').append(local_media);
                   attachMediaStream(local_media[0], stream);
       
                   if (callback) callback();
               },
               function() { // user denied access to a/v 
                   console.log("Access denied for audio/video");
                   alert("You chose not to provide access to the camera/microphone, demo will not work.");
                   if (errorback) errorback();
               });
           */
            // And that's my replacement..

            async function getMedia(constraints) {
                let stream = null;

                try {
                    stream = await navigator.mediaDevices.getUserMedia(constraints);
                    /* use the stream */
                    console.log("Access granted to audio/video");
                    webRTC.local_media_stream = stream;
                    var local_media = webRTC.USE_VIDEO ? $("<video>") : $("<audio>");
                    local_media.attr("autoplay", "autoplay");
                    local_media.attr("muted", "true"); // always mute ourselves by default 
                    local_media.attr("controls", "");
                    $('body').append(local_media);
                    webRTC.attachMediaStream(local_media[0], stream);
                    if (callback) callback();
                } catch (err) {
                    /* handle the error */
                    console.log("Access denied for audio/video");
                    alert("You chose not to provide access to the camera/microphone, demo will not work.");
                    if (errorback) errorback();
                }
            }

            getMedia({ audio: true });




        }
    }
}