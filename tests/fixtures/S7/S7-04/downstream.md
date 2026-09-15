### Raw 101 response head (exact bytes)
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: T3Bs9tEVuDKsUFIor26RR43kHo4=
```

### Computed Sec-WebSocket-Accept
```
T3Bs9tEVuDKsUFIor26RR43kHo4=
```

### Header Sec-WebSocket-Accept from server
```
T3Bs9tEVuDKsUFIor26RR43kHo4=
```

### Accept matches computed value: True

### Bytes received before client close (server-initiated): b'' (server sends no message; it waits for client JSON)

### Bytes received after masked close frame (opcode 0x88, payload 03 E8): b'\x88\x02\x03\xe8'
