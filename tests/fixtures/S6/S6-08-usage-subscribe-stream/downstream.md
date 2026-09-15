# S6-08-usage-subscribe-stream — RESP server->client byte stream (connections numbered, byte-exact)



## conn 1 — AUTH + SUBSCRIBE + live message + PING + UNSUBSCRIBE — 1612 bytes received
```
00000000  2b 4f 4b 0d 0a 2a 33 0d 0a 24 39 0d 0a 73 75 62  |+OK..*3..$9..sub|
00000010  73 63 72 69 62 65 0d 0a 24 35 0d 0a 75 73 61 67  |scribe..$5..usag|
00000020  65 0d 0a 3a 31 0d 0a 2a 33 0d 0a 24 37 0d 0a 6d  |e..:1..*3..$7..m|
00000030  65 73 73 61 67 65 0d 0a 24 35 0d 0a 75 73 61 67  |essage..$5..usag|
00000040  65 0d 0a 24 32 34 0d 0a 7b 22 73 75 70 70 6f 72  |e..$24..{"suppor|
00000050  74 5f 72 65 66 72 65 73 68 22 3a 74 72 75 65 7d  |t_refresh":true}|
00000060  0d 0a 2a 33 0d 0a 24 37 0d 0a 6d 65 73 73 61 67  |..*3..$7..messag|
00000070  65 0d 0a 24 35 0d 0a 75 73 61 67 65 0d 0a 24 31  |e..$5..usage..$1|
00000080  33 39 36 0d 0a 7b 22 74 69 6d 65 73 74 61 6d 70  |396..{"timestamp|
00000090  22 3a 22 32 30 32 36 2d 30 39 2d 31 36 54 30 31  |":"2026-09-16T01|
000000a0  3a 31 37 3a 31 31 2e 33 35 37 31 37 36 35 30 35  |:17:11.357176505|
000000b0  2b 30 38 3a 30 30 22 2c 22 6c 61 74 65 6e 63 79  |+08:00","latency|
000000c0  5f 6d 73 22 3a 31 32 2c 22 74 74 66 74 5f 6d 73  |_ms":12,"ttft_ms|
000000d0  22 3a 31 32 2c 22 73 6f 75 72 63 65 22 3a 22 6d  |":12,"source":"m|
000000e0  6f 63 6b 2d 75 70 73 74 72 65 61 6d 2d 6b 65 79  |ock-upstream-key|
000000f0  22 2c 22 61 75 74 68 5f 69 6e 64 65 78 22 3a 22  |","auth_index":"|
00000100  34 37 38 62 30 30 38 34 38 39 35 33 38 64 32 38  |478b008489538d28|
00000110  22 2c 22 63 6c 69 65 6e 74 5f 69 70 22 3a 22 31  |","client_ip":"1|
00000120  37 32 2e 31 37 2e 30 2e 31 22 2c 22 78 5f 66 6f  |72.17.0.1","x_fo|
00000130  72 77 61 72 64 65 64 5f 66 6f 72 22 3a 22 22 2c  |rwarded_for":"",|
00000140  22 75 73 65 72 5f 61 67 65 6e 74 22 3a 22 6f 72  |"user_agent":"or|
00000150  61 63 6c 65 2d 73 33 2d 70 72 6f 62 65 2f 31 2e  |acle-s3-probe/1.|
00000160  30 22 2c 22 74 6f 6b 65 6e 73 22 3a 7b 22 69 6e  |0","tokens":{"in|
00000170  70 75 74 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 6f  |put_tokens":0,"o|
00000180  75 74 70 75 74 5f 74 6f 6b 65 6e 73 22 3a 30 2c  |utput_tokens":0,|
00000190  22 72 65 61 73 6f 6e 69 6e 67 5f 74 6f 6b 65 6e  |"reasoning_token|
000001a0  73 22 3a 30 2c 22 63 61 63 68 65 64 5f 74 6f 6b  |s":0,"cached_tok|
000001b0  65 6e 73 22 3a 30 2c 22 63 61 63 68 65 5f 72 65  |ens":0,"cache_re|
000001c0  61 64 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63 61  |ad_tokens":0,"ca|
000001d0  63 68 65 5f 72 65 61 64 5f 74 6f 6b 65 6e 73 5f  |che_read_tokens_|
000001e0  70 72 65 73 65 6e 74 22 3a 74 72 75 65 2c 22 63  |present":true,"c|
000001f0  61 63 68 65 5f 63 72 65 61 74 69 6f 6e 5f 74 6f  |ache_creation_to|
00000200  6b 65 6e 73 22 3a 30 2c 22 74 6f 74 61 6c 5f 74  |kens":0,"total_t|
00000210  6f 6b 65 6e 73 22 3a 30 7d 2c 22 66 61 69 6c 65  |okens":0},"faile|
00000220  64 22 3a 74 72 75 65 2c 22 67 65 6e 65 72 61 74  |d":true,"generat|
00000230  65 22 3a 74 72 75 65 2c 22 73 74 72 65 61 6d 22  |e":true,"stream"|
00000240  3a 66 61 6c 73 65 2c 22 66 61 69 6c 22 3a 7b 22  |:false,"fail":{"|
00000250  73 74 61 74 75 73 5f 63 6f 64 65 22 3a 35 30 30  |status_code":500|
00000260  2c 22 62 6f 64 79 22 3a 22 7b 5c 22 65 72 72 6f  |,"body":"{\"erro|
00000270  72 5c 22 3a 20 7b 5c 22 6d 65 73 73 61 67 65 5c  |r\": {\"message\|
00000280  22 3a 20 5c 22 6d 6f 63 6b 20 72 61 74 65 20 6c  |": \"mock rate l|
00000290  69 6d 69 74 5c 22 2c 20 5c 22 74 79 70 65 5c 22  |imit\", \"type\"|
000002a0  3a 20 5c 22 72 61 74 65 5f 6c 69 6d 69 74 5f 65  |: \"rate_limit_e|
000002b0  78 63 65 65 64 65 64 5c 22 2c 20 5c 22 63 6f 64  |xceeded\", \"cod|
000002c0  65 5c 22 3a 20 5c 22 72 61 74 65 5f 6c 69 6d 69  |e\": \"rate_limi|
000002d0  74 5f 65 78 63 65 65 64 65 64 5c 22 7d 7d 22 7d  |t_exceeded\"}}"}|
000002e0  2c 22 72 65 73 70 6f 6e 73 65 5f 68 65 61 64 65  |,"response_heade|
000002f0  72 73 22 3a 7b 22 43 6f 6e 74 65 6e 74 2d 4c 65  |rs":{"Content-Le|
00000300  6e 67 74 68 22 3a 5b 22 31 30 33 22 5d 2c 22 43  |ngth":["103"],"C|
00000310  6f 6e 74 65 6e 74 2d 54 79 70 65 22 3a 5b 22 61  |ontent-Type":["a|
00000320  70 70 6c 69 63 61 74 69 6f 6e 2f 6a 73 6f 6e 22  |pplication/json"|
00000330  5d 2c 22 44 61 74 65 22 3a 5b 22 54 75 65 2c 20  |],"Date":["Tue, |
00000340  31 35 20 53 65 70 20 32 30 32 36 20 31 37 3a 31  |15 Sep 2026 17:1|
00000350  37 3a 31 31 20 47 4d 54 22 5d 2c 22 53 65 72 76  |7:11 GMT"],"Serv|
00000360  65 72 22 3a 5b 22 42 61 73 65 48 54 54 50 2f 30  |er":["BaseHTTP/0|
00000370  2e 36 20 50 79 74 68 6f 6e 2f 33 2e 31 34 2e 36  |.6 Python/3.14.6|
00000380  22 5d 7d 2c 22 61 63 63 6f 75 6e 74 69 6e 67 5f  |"]},"accounting_|
00000390  76 65 72 73 69 6f 6e 22 3a 32 2c 22 74 6f 6b 65  |version":2,"toke|
000003a0  6e 5f 62 72 65 61 6b 64 6f 77 6e 22 3a 7b 22 73  |n_breakdown":{"s|
000003b0  63 68 65 6d 61 5f 76 65 72 73 69 6f 6e 22 3a 32  |chema_version":2|
000003c0  2c 22 71 75 61 6c 69 74 79 22 3a 22 63 6f 6d 70  |,"quality":"comp|
000003d0  6c 65 74 65 22 2c 22 74 6f 74 61 6c 5f 74 6f 6b  |lete","total_tok|
000003e0  65 6e 73 22 3a 30 2c 22 69 6e 70 75 74 22 3a 7b  |ens":0,"input":{|
000003f0  22 74 6f 74 61 6c 5f 74 6f 6b 65 6e 73 22 3a 30  |"total_tokens":0|
00000400  2c 22 75 6e 63 61 63 68 65 64 5f 74 6f 6b 65 6e  |,"uncached_token|
00000410  73 22 3a 30 2c 22 63 61 63 68 65 5f 72 65 61 64  |s":0,"cache_read|
00000420  5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63 61 63 68  |_tokens":0,"cach|
00000430  65 5f 77 72 69 74 65 5f 74 6f 6b 65 6e 73 22 3a  |e_write_tokens":|
00000440  30 7d 2c 22 6f 75 74 70 75 74 22 3a 7b 22 74 6f  |0},"output":{"to|
00000450  74 61 6c 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 6e  |tal_tokens":0,"n|
00000460  6f 6e 5f 72 65 61 73 6f 6e 69 6e 67 5f 74 6f 6b  |on_reasoning_tok|
00000470  65 6e 73 22 3a 30 2c 22 72 65 61 73 6f 6e 69 6e  |ens":0,"reasonin|
00000480  67 5f 74 6f 6b 65 6e 73 22 3a 30 7d 2c 22 75 6e  |g_tokens":0},"un|
00000490  63 6c 61 73 73 69 66 69 65 64 5f 74 6f 6b 65 6e  |classified_token|
000004a0  73 22 3a 30 7d 2c 22 70 72 6f 76 69 64 65 72 22  |s":0},"provider"|
000004b0  3a 22 6f 70 65 6e 61 69 2d 63 6f 6d 70 61 74 69  |:"openai-compati|
000004c0  62 6c 65 2d 6d 6f 63 6b 2d 6f 70 65 6e 61 69 22  |ble-mock-openai"|
000004d0  2c 22 65 78 65 63 75 74 6f 72 5f 74 79 70 65 22  |,"executor_type"|
000004e0  3a 22 4f 70 65 6e 41 49 43 6f 6d 70 61 74 45 78  |:"OpenAICompatEx|
000004f0  65 63 75 74 6f 72 22 2c 22 6d 6f 64 65 6c 22 3a  |ecutor","model":|
00000500  22 6d 6f 63 6b 2d 67 70 74 2d 6d 6f 64 65 6c 22  |"mock-gpt-model"|
00000510  2c 22 61 6c 69 61 73 22 3a 22 6d 6f 63 6b 2d 6d  |,"alias":"mock-m|
00000520  6f 64 65 6c 22 2c 22 65 6e 64 70 6f 69 6e 74 22  |odel","endpoint"|
00000530  3a 22 50 4f 53 54 20 2f 76 31 2f 63 68 61 74 2f  |:"POST /v1/chat/|
00000540  63 6f 6d 70 6c 65 74 69 6f 6e 73 22 2c 22 61 75  |completions","au|
00000550  74 68 5f 74 79 70 65 22 3a 22 61 70 69 6b 65 79  |th_type":"apikey|
00000560  22 2c 22 61 70 69 5f 6b 65 79 22 3a 22 6f 72 61  |","api_key":"ora|
00000570  63 6c 65 2d 6c 6f 63 61 6c 2d 6b 65 79 2d 31 22  |cle-local-key-1"|
00000580  2c 22 72 65 71 75 65 73 74 5f 69 64 22 3a 22 32  |,"request_id":"2|
00000590  31 31 35 34 31 30 32 22 2c 22 73 65 73 73 69 6f  |1154102","sessio|
000005a0  6e 5f 69 64 22 3a 22 35 36 64 66 30 33 30 62 2d  |n_id":"56df030b-|
000005b0  37 66 35 32 2d 38 38 36 66 2d 39 64 37 64 2d 35  |7f52-886f-9d7d-5|
000005c0  31 30 38 33 62 30 32 64 64 33 62 22 2c 22 72 65  |1083b02dd3b","re|
000005d0  61 73 6f 6e 69 6e 67 5f 65 66 66 6f 72 74 22 3a  |asoning_effort":|
000005e0  22 22 2c 22 73 65 72 76 69 63 65 5f 74 69 65 72  |"","service_tier|
000005f0  22 3a 22 61 75 74 6f 22 7d 0d 0a 2a 32 0d 0a 24  |":"auto"}..*2..$|
00000600  34 0d 0a 70 6f 6e 67 0d 0a 24 2d 31 0d 0a 2a 32  |4..pong..$-1..*2|
00000610  0d 0a 24 34 0d 0a 70 6f 6e 67 0d 0a 24 35 0d 0a  |..$4..pong..$5..|
00000620  68 65 6c 6c 6f 0d 0a 2a 33 0d 0a 24 31 31 0d 0a  |hello..*3..$11..|
00000630  75 6e 73 75 62 73 63 72 69 62 65 0d 0a 24 35 0d  |unsubscribe..$5.|
00000640  0a 75 73 61 67 65 0d 0a 3a 30 0d 0a              |.usage..:0..|
```
literal (escaped):
```
+OK\r\n*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$24\r\n{"support_refresh":true}\r\n*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$1396\r\n{"timestamp":"2026-09-16T01:17:11.357176505+08:00","latency_ms":12,"ttft_ms":12,"source":"mock-upstream-key","auth_index":"478b008489538d28","client_ip":"172.17.0.1","x_forwarded_for":"","user_agent":"oracle-s3-probe/1.0","tokens":{"input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cached_tokens":0,"cache_read_tokens":0,"cache_read_tokens_present":true,"cache_creation_tokens":0,"total_tokens":0},"failed":true,"generate":true,"stream":false,"fail":{"status_code":500,"body":"{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}"},"response_headers":{"Content-Length":["103"],"Content-Type":["application/json"],"Date":["Tue, 15 Sep 2026 17:17:11 GMT"],"Server":["BaseHTTP/0.6 Python/3.14.6"]},"accounting_version":2,"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":0,"input":{"total_tokens":0,"uncached_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":0,"non_reasoning_tokens":0,"reasoning_tokens":0},"unclassified_tokens":0},"provider":"openai-compatible-mock-openai","executor_type":"OpenAICompatExecutor","model":"mock-gpt-model","alias":"mock-model","endpoint":"POST /v1/chat/completions","auth_type":"apikey","api_key":"oracle-local-key-1","request_id":"21154102","session_id":"56df030b-7f52-886f-9d7d-51083b02dd3b","reasoning_effort":"","service_tier":"auto"}\r\n*2\r\n$4\r\npong\r\n$-1\r\n*2\r\n$4\r\npong\r\n$5\r\nhello\r\n*3\r\n$11\r\nunsubscribe\r\n$5\r\nusage\r\n:0\r\n
```
