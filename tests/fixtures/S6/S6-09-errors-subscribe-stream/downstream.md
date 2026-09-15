# S6-09-errors-subscribe-stream — RESP server->client byte stream (connections numbered, byte-exact)



## conn 1 — AUTH + SUBSCRIBE errors + live error event + QUIT — 843 bytes received
```
00000000  2b 4f 4b 0d 0a 2a 33 0d 0a 24 39 0d 0a 73 75 62  |+OK..*3..$9..sub|
00000010  73 63 72 69 62 65 0d 0a 24 36 0d 0a 65 72 72 6f  |scribe..$6..erro|
00000020  72 73 0d 0a 3a 31 0d 0a 2a 33 0d 0a 24 37 0d 0a  |rs..:1..*3..$7..|
00000030  6d 65 73 73 61 67 65 0d 0a 24 36 0d 0a 65 72 72  |message..$6..err|
00000040  6f 72 73 0d 0a 24 37 36 31 0d 0a 7b 22 74 69 6d  |ors..$761..{"tim|
00000050  65 73 74 61 6d 70 22 3a 22 32 30 32 36 2d 30 39  |estamp":"2026-09|
00000060  2d 31 36 54 30 31 3a 31 37 3a 31 34 2e 39 35 39  |-16T01:17:14.959|
00000070  35 34 35 34 36 35 2b 30 38 3a 30 30 22 2c 22 70  |545465+08:00","p|
00000080  72 6f 76 69 64 65 72 22 3a 22 6f 70 65 6e 61 69  |rovider":"openai|
00000090  2d 63 6f 6d 70 61 74 69 62 6c 65 2d 6d 6f 63 6b  |-compatible-mock|
000000a0  2d 6f 70 65 6e 61 69 22 2c 22 6d 6f 64 65 6c 22  |-openai","model"|
000000b0  3a 22 6d 6f 63 6b 2d 6d 6f 64 65 6c 22 2c 22 61  |:"mock-model","a|
000000c0  75 74 68 5f 69 64 22 3a 22 6f 70 65 6e 61 69 2d  |uth_id":"openai-|
000000d0  63 6f 6d 70 61 74 69 62 69 6c 69 74 79 3a 6d 6f  |compatibility:mo|
000000e0  63 6b 2d 6f 70 65 6e 61 69 3a 34 38 34 34 35 35  |ck-openai:484455|
000000f0  32 34 36 61 38 34 22 2c 22 61 75 74 68 5f 69 6e  |246a84","auth_in|
00000100  64 65 78 22 3a 22 34 37 38 62 30 30 38 34 38 39  |dex":"478b008489|
00000110  35 33 38 64 32 38 22 2c 22 73 74 61 74 75 73 5f  |538d28","status_|
00000120  63 6f 64 65 22 3a 35 30 30 2c 22 62 6f 64 79 22  |code":500,"body"|
00000130  3a 22 7b 5c 22 65 72 72 6f 72 5c 22 3a 20 7b 5c  |:"{\"error\": {\|
00000140  22 6d 65 73 73 61 67 65 5c 22 3a 20 5c 22 6d 6f  |"message\": \"mo|
00000150  63 6b 20 72 61 74 65 20 6c 69 6d 69 74 5c 22 2c  |ck rate limit\",|
00000160  20 5c 22 74 79 70 65 5c 22 3a 20 5c 22 72 61 74  | \"type\": \"rat|
00000170  65 5f 6c 69 6d 69 74 5f 65 78 63 65 65 64 65 64  |e_limit_exceeded|
00000180  5c 22 2c 20 5c 22 63 6f 64 65 5c 22 3a 20 5c 22  |\", \"code\": \"|
00000190  72 61 74 65 5f 6c 69 6d 69 74 5f 65 78 63 65 65  |rate_limit_excee|
000001a0  64 65 64 5c 22 7d 7d 22 2c 22 61 75 74 68 5f 73  |ded\"}}","auth_s|
000001b0  74 61 74 75 73 22 3a 7b 22 73 74 61 74 75 73 22  |tatus":{"status"|
000001c0  3a 22 65 72 72 6f 72 22 2c 22 73 74 61 74 75 73  |:"error","status|
000001d0  5f 6d 65 73 73 61 67 65 22 3a 22 7b 5c 22 65 72  |_message":"{\"er|
000001e0  72 6f 72 5c 22 3a 20 7b 5c 22 6d 65 73 73 61 67  |ror\": {\"messag|
000001f0  65 5c 22 3a 20 5c 22 6d 6f 63 6b 20 72 61 74 65  |e\": \"mock rate|
00000200  20 6c 69 6d 69 74 5c 22 2c 20 5c 22 74 79 70 65  | limit\", \"type|
00000210  5c 22 3a 20 5c 22 72 61 74 65 5f 6c 69 6d 69 74  |\": \"rate_limit|
00000220  5f 65 78 63 65 65 64 65 64 5c 22 2c 20 5c 22 63  |_exceeded\", \"c|
00000230  6f 64 65 5c 22 3a 20 5c 22 72 61 74 65 5f 6c 69  |ode\": \"rate_li|
00000240  6d 69 74 5f 65 78 63 65 65 64 65 64 5c 22 7d 7d  |mit_exceeded\"}}|
00000250  22 2c 22 64 69 73 61 62 6c 65 64 22 3a 66 61 6c  |","disabled":fal|
00000260  73 65 2c 22 75 6e 61 76 61 69 6c 61 62 6c 65 22  |se,"unavailable"|
00000270  3a 66 61 6c 73 65 2c 22 6d 6f 64 65 6c 22 3a 7b  |:false,"model":{|
00000280  22 6e 61 6d 65 22 3a 22 6d 6f 63 6b 2d 6d 6f 64  |"name":"mock-mod|
00000290  65 6c 22 2c 22 73 74 61 74 75 73 22 3a 22 65 72  |el","status":"er|
000002a0  72 6f 72 22 2c 22 73 74 61 74 75 73 5f 6d 65 73  |ror","status_mes|
000002b0  73 61 67 65 22 3a 22 7b 5c 22 65 72 72 6f 72 5c  |sage":"{\"error\|
000002c0  22 3a 20 7b 5c 22 6d 65 73 73 61 67 65 5c 22 3a  |": {\"message\":|
000002d0  20 5c 22 6d 6f 63 6b 20 72 61 74 65 20 6c 69 6d  | \"mock rate lim|
000002e0  69 74 5c 22 2c 20 5c 22 74 79 70 65 5c 22 3a 20  |it\", \"type\": |
000002f0  5c 22 72 61 74 65 5f 6c 69 6d 69 74 5f 65 78 63  |\"rate_limit_exc|
00000300  65 65 64 65 64 5c 22 2c 20 5c 22 63 6f 64 65 5c  |eeded\", \"code\|
00000310  22 3a 20 5c 22 72 61 74 65 5f 6c 69 6d 69 74 5f  |": \"rate_limit_|
00000320  65 78 63 65 65 64 65 64 5c 22 7d 7d 22 2c 22 75  |exceeded\"}}","u|
00000330  6e 61 76 61 69 6c 61 62 6c 65 22 3a 66 61 6c 73  |navailable":fals|
00000340  65 7d 7d 7d 0d 0a 2b 4f 4b 0d 0a                 |e}}}..+OK..|
```
literal (escaped):
```
+OK\r\n*3\r\n$9\r\nsubscribe\r\n$6\r\nerrors\r\n:1\r\n*3\r\n$7\r\nmessage\r\n$6\r\nerrors\r\n$761\r\n{"timestamp":"2026-09-16T01:17:14.959545465+08:00","provider":"openai-compatible-mock-openai","model":"mock-model","auth_id":"openai-compatibility:mock-openai:484455246a84","auth_index":"478b008489538d28","status_code":500,"body":"{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}","auth_status":{"status":"error","status_message":"{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}","disabled":false,"unavailable":false,"model":{"name":"mock-model","status":"error","status_message":"{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}","unavailable":false}}}\r\n+OK\r\n
```
