# S6-08-usage-subscribe-stream — RESP server->client byte stream (connections numbered, byte-exact)



## conn 1 — AUTH + SUBSCRIBE + live message + PING + UNSUBSCRIBE — 1496 bytes received
```
00000000  2b 4f 4b 0d 0a 2a 33 0d 0a 24 39 0d 0a 73 75 62  |+OK..*3..$9..sub|
00000010  73 63 72 69 62 65 0d 0a 24 35 0d 0a 75 73 61 67  |scribe..$5..usag|
00000020  65 0d 0a 3a 31 0d 0a 2a 33 0d 0a 24 37 0d 0a 6d  |e..:1..*3..$7..m|
00000030  65 73 73 61 67 65 0d 0a 24 35 0d 0a 75 73 61 67  |essage..$5..usag|
00000040  65 0d 0a 24 32 34 0d 0a 7b 22 73 75 70 70 6f 72  |e..$24..{"suppor|
00000050  74 5f 72 65 66 72 65 73 68 22 3a 74 72 75 65 7d  |t_refresh":true}|
00000060  0d 0a 2a 33 0d 0a 24 37 0d 0a 6d 65 73 73 61 67  |..*3..$7..messag|
00000070  65 0d 0a 24 35 0d 0a 75 73 61 67 65 0d 0a 24 31  |e..$5..usage..$1|
00000080  32 38 30 0d 0a 7b 22 74 69 6d 65 73 74 61 6d 70  |280..{"timestamp|
00000090  22 3a 22 32 30 32 36 2d 30 39 2d 31 36 54 30 31  |":"2026-09-16T01|
000000a0  3a 32 30 3a 32 32 2e 32 36 33 39 31 31 39 36 38  |:20:22.263911968|
000000b0  2b 30 38 3a 30 30 22 2c 22 6c 61 74 65 6e 63 79  |+08:00","latency|
000000c0  5f 6d 73 22 3a 31 2c 22 74 74 66 74 5f 6d 73 22  |_ms":1,"ttft_ms"|
000000d0  3a 31 2c 22 73 6f 75 72 63 65 22 3a 22 6d 6f 63  |:1,"source":"moc|
000000e0  6b 2d 75 70 73 74 72 65 61 6d 2d 6b 65 79 22 2c  |k-upstream-key",|
000000f0  22 61 75 74 68 5f 69 6e 64 65 78 22 3a 22 34 37  |"auth_index":"47|
00000100  38 62 30 30 38 34 38 39 35 33 38 64 32 38 22 2c  |8b008489538d28",|
00000110  22 63 6c 69 65 6e 74 5f 69 70 22 3a 22 31 37 32  |"client_ip":"172|
00000120  2e 31 37 2e 30 2e 31 22 2c 22 78 5f 66 6f 72 77  |.17.0.1","x_forw|
00000130  61 72 64 65 64 5f 66 6f 72 22 3a 22 22 2c 22 75  |arded_for":"","u|
00000140  73 65 72 5f 61 67 65 6e 74 22 3a 22 6f 72 61 63  |ser_agent":"orac|
00000150  6c 65 2d 73 33 2d 70 72 6f 62 65 2f 31 2e 30 22  |le-s3-probe/1.0"|
00000160  2c 22 74 6f 6b 65 6e 73 22 3a 7b 22 69 6e 70 75  |,"tokens":{"inpu|
00000170  74 5f 74 6f 6b 65 6e 73 22 3a 39 2c 22 6f 75 74  |t_tokens":9,"out|
00000180  70 75 74 5f 74 6f 6b 65 6e 73 22 3a 36 2c 22 72  |put_tokens":6,"r|
00000190  65 61 73 6f 6e 69 6e 67 5f 74 6f 6b 65 6e 73 22  |easoning_tokens"|
000001a0  3a 30 2c 22 63 61 63 68 65 64 5f 74 6f 6b 65 6e  |:0,"cached_token|
000001b0  73 22 3a 30 2c 22 63 61 63 68 65 5f 72 65 61 64  |s":0,"cache_read|
000001c0  5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63 61 63 68  |_tokens":0,"cach|
000001d0  65 5f 72 65 61 64 5f 74 6f 6b 65 6e 73 5f 70 72  |e_read_tokens_pr|
000001e0  65 73 65 6e 74 22 3a 74 72 75 65 2c 22 63 61 63  |esent":true,"cac|
000001f0  68 65 5f 63 72 65 61 74 69 6f 6e 5f 74 6f 6b 65  |he_creation_toke|
00000200  6e 73 22 3a 30 2c 22 74 6f 74 61 6c 5f 74 6f 6b  |ns":0,"total_tok|
00000210  65 6e 73 22 3a 31 35 7d 2c 22 66 61 69 6c 65 64  |ens":15},"failed|
00000220  22 3a 66 61 6c 73 65 2c 22 67 65 6e 65 72 61 74  |":false,"generat|
00000230  65 22 3a 74 72 75 65 2c 22 73 74 72 65 61 6d 22  |e":true,"stream"|
00000240  3a 66 61 6c 73 65 2c 22 66 61 69 6c 22 3a 7b 22  |:false,"fail":{"|
00000250  73 74 61 74 75 73 5f 63 6f 64 65 22 3a 32 30 30  |status_code":200|
00000260  2c 22 62 6f 64 79 22 3a 22 22 7d 2c 22 72 65 73  |,"body":""},"res|
00000270  70 6f 6e 73 65 5f 68 65 61 64 65 72 73 22 3a 7b  |ponse_headers":{|
00000280  22 43 6f 6e 74 65 6e 74 2d 4c 65 6e 67 74 68 22  |"Content-Length"|
00000290  3a 5b 22 33 31 39 22 5d 2c 22 43 6f 6e 74 65 6e  |:["319"],"Conten|
000002a0  74 2d 54 79 70 65 22 3a 5b 22 61 70 70 6c 69 63  |t-Type":["applic|
000002b0  61 74 69 6f 6e 2f 6a 73 6f 6e 22 5d 2c 22 44 61  |ation/json"],"Da|
000002c0  74 65 22 3a 5b 22 54 75 65 2c 20 31 35 20 53 65  |te":["Tue, 15 Se|
000002d0  70 20 32 30 32 36 20 31 37 3a 32 30 3a 32 32 20  |p 2026 17:20:22 |
000002e0  47 4d 54 22 5d 2c 22 53 65 72 76 65 72 22 3a 5b  |GMT"],"Server":[|
000002f0  22 42 61 73 65 48 54 54 50 2f 30 2e 36 20 50 79  |"BaseHTTP/0.6 Py|
00000300  74 68 6f 6e 2f 33 2e 31 34 2e 36 22 5d 7d 2c 22  |thon/3.14.6"]},"|
00000310  61 63 63 6f 75 6e 74 69 6e 67 5f 76 65 72 73 69  |accounting_versi|
00000320  6f 6e 22 3a 32 2c 22 74 6f 6b 65 6e 5f 62 72 65  |on":2,"token_bre|
00000330  61 6b 64 6f 77 6e 22 3a 7b 22 73 63 68 65 6d 61  |akdown":{"schema|
00000340  5f 76 65 72 73 69 6f 6e 22 3a 32 2c 22 71 75 61  |_version":2,"qua|
00000350  6c 69 74 79 22 3a 22 63 6f 6d 70 6c 65 74 65 22  |lity":"complete"|
00000360  2c 22 74 6f 74 61 6c 5f 74 6f 6b 65 6e 73 22 3a  |,"total_tokens":|
00000370  31 35 2c 22 69 6e 70 75 74 22 3a 7b 22 74 6f 74  |15,"input":{"tot|
00000380  61 6c 5f 74 6f 6b 65 6e 73 22 3a 39 2c 22 75 6e  |al_tokens":9,"un|
00000390  63 61 63 68 65 64 5f 74 6f 6b 65 6e 73 22 3a 39  |cached_tokens":9|
000003a0  2c 22 63 61 63 68 65 5f 72 65 61 64 5f 74 6f 6b  |,"cache_read_tok|
000003b0  65 6e 73 22 3a 30 2c 22 63 61 63 68 65 5f 77 72  |ens":0,"cache_wr|
000003c0  69 74 65 5f 74 6f 6b 65 6e 73 22 3a 30 7d 2c 22  |ite_tokens":0},"|
000003d0  6f 75 74 70 75 74 22 3a 7b 22 74 6f 74 61 6c 5f  |output":{"total_|
000003e0  74 6f 6b 65 6e 73 22 3a 36 2c 22 6e 6f 6e 5f 72  |tokens":6,"non_r|
000003f0  65 61 73 6f 6e 69 6e 67 5f 74 6f 6b 65 6e 73 22  |easoning_tokens"|
00000400  3a 36 2c 22 72 65 61 73 6f 6e 69 6e 67 5f 74 6f  |:6,"reasoning_to|
00000410  6b 65 6e 73 22 3a 30 7d 2c 22 75 6e 63 6c 61 73  |kens":0},"unclas|
00000420  73 69 66 69 65 64 5f 74 6f 6b 65 6e 73 22 3a 30  |sified_tokens":0|
00000430  7d 2c 22 70 72 6f 76 69 64 65 72 22 3a 22 6f 70  |},"provider":"op|
00000440  65 6e 61 69 2d 63 6f 6d 70 61 74 69 62 6c 65 2d  |enai-compatible-|
00000450  6d 6f 63 6b 2d 6f 70 65 6e 61 69 22 2c 22 65 78  |mock-openai","ex|
00000460  65 63 75 74 6f 72 5f 74 79 70 65 22 3a 22 4f 70  |ecutor_type":"Op|
00000470  65 6e 41 49 43 6f 6d 70 61 74 45 78 65 63 75 74  |enAICompatExecut|
00000480  6f 72 22 2c 22 6d 6f 64 65 6c 22 3a 22 6d 6f 63  |or","model":"moc|
00000490  6b 2d 67 70 74 2d 6d 6f 64 65 6c 22 2c 22 61 6c  |k-gpt-model","al|
000004a0  69 61 73 22 3a 22 6d 6f 63 6b 2d 6d 6f 64 65 6c  |ias":"mock-model|
000004b0  22 2c 22 65 6e 64 70 6f 69 6e 74 22 3a 22 50 4f  |","endpoint":"PO|
000004c0  53 54 20 2f 76 31 2f 63 68 61 74 2f 63 6f 6d 70  |ST /v1/chat/comp|
000004d0  6c 65 74 69 6f 6e 73 22 2c 22 61 75 74 68 5f 74  |letions","auth_t|
000004e0  79 70 65 22 3a 22 61 70 69 6b 65 79 22 2c 22 61  |ype":"apikey","a|
000004f0  70 69 5f 6b 65 79 22 3a 22 6f 72 61 63 6c 65 2d  |pi_key":"oracle-|
00000500  6c 6f 63 61 6c 2d 6b 65 79 2d 31 22 2c 22 72 65  |local-key-1","re|
00000510  71 75 65 73 74 5f 69 64 22 3a 22 36 32 35 66 38  |quest_id":"625f8|
00000520  34 37 37 22 2c 22 73 65 73 73 69 6f 6e 5f 69 64  |477","session_id|
00000530  22 3a 22 35 36 64 66 30 33 30 62 2d 37 66 35 32  |":"56df030b-7f52|
00000540  2d 38 38 36 66 2d 39 64 37 64 2d 35 31 30 38 33  |-886f-9d7d-51083|
00000550  62 30 32 64 64 33 62 22 2c 22 72 65 61 73 6f 6e  |b02dd3b","reason|
00000560  69 6e 67 5f 65 66 66 6f 72 74 22 3a 22 22 2c 22  |ing_effort":"","|
00000570  73 65 72 76 69 63 65 5f 74 69 65 72 22 3a 22 61  |service_tier":"a|
00000580  75 74 6f 22 7d 0d 0a 2a 32 0d 0a 24 34 0d 0a 70  |uto"}..*2..$4..p|
00000590  6f 6e 67 0d 0a 24 2d 31 0d 0a 2a 32 0d 0a 24 34  |ong..$-1..*2..$4|
000005a0  0d 0a 70 6f 6e 67 0d 0a 24 35 0d 0a 68 65 6c 6c  |..pong..$5..hell|
000005b0  6f 0d 0a 2a 33 0d 0a 24 31 31 0d 0a 75 6e 73 75  |o..*3..$11..unsu|
000005c0  62 73 63 72 69 62 65 0d 0a 24 35 0d 0a 75 73 61  |bscribe..$5..usa|
000005d0  67 65 0d 0a 3a 30 0d 0a                          |ge..:0..|
```
literal (escaped):
```
+OK\r\n*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$24\r\n{"support_refresh":true}\r\n*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$1280\r\n{"timestamp":"2026-09-16T01:20:22.263911968+08:00","latency_ms":1,"ttft_ms":1,"source":"mock-upstream-key","auth_index":"478b008489538d28","client_ip":"172.17.0.1","x_forwarded_for":"","user_agent":"oracle-s3-probe/1.0","tokens":{"input_tokens":9,"output_tokens":6,"reasoning_tokens":0,"cached_tokens":0,"cache_read_tokens":0,"cache_read_tokens_present":true,"cache_creation_tokens":0,"total_tokens":15},"failed":false,"generate":true,"stream":false,"fail":{"status_code":200,"body":""},"response_headers":{"Content-Length":["319"],"Content-Type":["application/json"],"Date":["Tue, 15 Sep 2026 17:20:22 GMT"],"Server":["BaseHTTP/0.6 Python/3.14.6"]},"accounting_version":2,"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":15,"input":{"total_tokens":9,"uncached_tokens":9,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":6,"non_reasoning_tokens":6,"reasoning_tokens":0},"unclassified_tokens":0},"provider":"openai-compatible-mock-openai","executor_type":"OpenAICompatExecutor","model":"mock-gpt-model","alias":"mock-model","endpoint":"POST /v1/chat/completions","auth_type":"apikey","api_key":"oracle-local-key-1","request_id":"625f8477","session_id":"56df030b-7f52-886f-9d7d-51083b02dd3b","reasoning_effort":"","service_tier":"auto"}\r\n*2\r\n$4\r\npong\r\n$-1\r\n*2\r\n$4\r\npong\r\n$5\r\nhello\r\n*3\r\n$11\r\nunsubscribe\r\n$5\r\nusage\r\n:0\r\n
```
