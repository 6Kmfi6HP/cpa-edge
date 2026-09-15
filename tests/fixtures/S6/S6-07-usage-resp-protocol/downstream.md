# S6-07-usage-resp-protocol — RESP server->client byte stream (connections numbered, byte-exact)



## conn 1 — unauthenticated LPOP — 34 bytes received
```
00000000  2d 4e 4f 41 55 54 48 20 41 75 74 68 65 6e 74 69  |-NOAUTH Authenti|
00000010  63 61 74 69 6f 6e 20 72 65 71 75 69 72 65 64 2e  |cation required.|
00000020  0d 0a                                            |..|
```
literal (escaped):
```
-NOAUTH Authentication required.\r\n
```

## conn 2 — AUTH with wrong key — 21 bytes received
```
00000000  2d 45 52 52 20 70 72 6f 74 6f 63 6f 6c 20 65 72  |-ERR protocol er|
00000010  72 6f 72 0d 0a                                   |ror..|
```
literal (escaped):
```
-ERR protocol error\r\n
```

## conn 3 — AUTH + LPOP/RPOP + errors channel + unknown + QUIT — 2688 bytes received
```
00000000  2b 4f 4b 0d 0a 2a 32 0d 0a 24 31 32 38 30 0d 0a  |+OK..*2..$1280..|
00000010  7b 22 74 69 6d 65 73 74 61 6d 70 22 3a 22 32 30  |{"timestamp":"20|
00000020  32 36 2d 30 39 2d 31 36 54 30 31 3a 32 30 3a 31  |26-09-16T01:20:1|
00000030  35 2e 38 34 32 38 37 31 34 36 35 2b 30 38 3a 30  |5.842871465+08:0|
00000040  30 22 2c 22 6c 61 74 65 6e 63 79 5f 6d 73 22 3a  |0","latency_ms":|
00000050  31 2c 22 74 74 66 74 5f 6d 73 22 3a 31 2c 22 73  |1,"ttft_ms":1,"s|
00000060  6f 75 72 63 65 22 3a 22 6d 6f 63 6b 2d 75 70 73  |ource":"mock-ups|
00000070  74 72 65 61 6d 2d 6b 65 79 22 2c 22 61 75 74 68  |tream-key","auth|
00000080  5f 69 6e 64 65 78 22 3a 22 34 37 38 62 30 30 38  |_index":"478b008|
00000090  34 38 39 35 33 38 64 32 38 22 2c 22 63 6c 69 65  |489538d28","clie|
000000a0  6e 74 5f 69 70 22 3a 22 31 37 32 2e 31 37 2e 30  |nt_ip":"172.17.0|
000000b0  2e 31 22 2c 22 78 5f 66 6f 72 77 61 72 64 65 64  |.1","x_forwarded|
000000c0  5f 66 6f 72 22 3a 22 22 2c 22 75 73 65 72 5f 61  |_for":"","user_a|
000000d0  67 65 6e 74 22 3a 22 6f 72 61 63 6c 65 2d 73 33  |gent":"oracle-s3|
000000e0  2d 70 72 6f 62 65 2f 31 2e 30 22 2c 22 74 6f 6b  |-probe/1.0","tok|
000000f0  65 6e 73 22 3a 7b 22 69 6e 70 75 74 5f 74 6f 6b  |ens":{"input_tok|
00000100  65 6e 73 22 3a 39 2c 22 6f 75 74 70 75 74 5f 74  |ens":9,"output_t|
00000110  6f 6b 65 6e 73 22 3a 36 2c 22 72 65 61 73 6f 6e  |okens":6,"reason|
00000120  69 6e 67 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63  |ing_tokens":0,"c|
00000130  61 63 68 65 64 5f 74 6f 6b 65 6e 73 22 3a 30 2c  |ached_tokens":0,|
00000140  22 63 61 63 68 65 5f 72 65 61 64 5f 74 6f 6b 65  |"cache_read_toke|
00000150  6e 73 22 3a 30 2c 22 63 61 63 68 65 5f 72 65 61  |ns":0,"cache_rea|
00000160  64 5f 74 6f 6b 65 6e 73 5f 70 72 65 73 65 6e 74  |d_tokens_present|
00000170  22 3a 74 72 75 65 2c 22 63 61 63 68 65 5f 63 72  |":true,"cache_cr|
00000180  65 61 74 69 6f 6e 5f 74 6f 6b 65 6e 73 22 3a 30  |eation_tokens":0|
00000190  2c 22 74 6f 74 61 6c 5f 74 6f 6b 65 6e 73 22 3a  |,"total_tokens":|
000001a0  31 35 7d 2c 22 66 61 69 6c 65 64 22 3a 66 61 6c  |15},"failed":fal|
000001b0  73 65 2c 22 67 65 6e 65 72 61 74 65 22 3a 74 72  |se,"generate":tr|
000001c0  75 65 2c 22 73 74 72 65 61 6d 22 3a 66 61 6c 73  |ue,"stream":fals|
000001d0  65 2c 22 66 61 69 6c 22 3a 7b 22 73 74 61 74 75  |e,"fail":{"statu|
000001e0  73 5f 63 6f 64 65 22 3a 32 30 30 2c 22 62 6f 64  |s_code":200,"bod|
000001f0  79 22 3a 22 22 7d 2c 22 72 65 73 70 6f 6e 73 65  |y":""},"response|
00000200  5f 68 65 61 64 65 72 73 22 3a 7b 22 43 6f 6e 74  |_headers":{"Cont|
00000210  65 6e 74 2d 4c 65 6e 67 74 68 22 3a 5b 22 33 31  |ent-Length":["31|
00000220  39 22 5d 2c 22 43 6f 6e 74 65 6e 74 2d 54 79 70  |9"],"Content-Typ|
00000230  65 22 3a 5b 22 61 70 70 6c 69 63 61 74 69 6f 6e  |e":["application|
00000240  2f 6a 73 6f 6e 22 5d 2c 22 44 61 74 65 22 3a 5b  |/json"],"Date":[|
00000250  22 54 75 65 2c 20 31 35 20 53 65 70 20 32 30 32  |"Tue, 15 Sep 202|
00000260  36 20 31 37 3a 32 30 3a 31 35 20 47 4d 54 22 5d  |6 17:20:15 GMT"]|
00000270  2c 22 53 65 72 76 65 72 22 3a 5b 22 42 61 73 65  |,"Server":["Base|
00000280  48 54 54 50 2f 30 2e 36 20 50 79 74 68 6f 6e 2f  |HTTP/0.6 Python/|
00000290  33 2e 31 34 2e 36 22 5d 7d 2c 22 61 63 63 6f 75  |3.14.6"]},"accou|
000002a0  6e 74 69 6e 67 5f 76 65 72 73 69 6f 6e 22 3a 32  |nting_version":2|
000002b0  2c 22 74 6f 6b 65 6e 5f 62 72 65 61 6b 64 6f 77  |,"token_breakdow|
000002c0  6e 22 3a 7b 22 73 63 68 65 6d 61 5f 76 65 72 73  |n":{"schema_vers|
000002d0  69 6f 6e 22 3a 32 2c 22 71 75 61 6c 69 74 79 22  |ion":2,"quality"|
000002e0  3a 22 63 6f 6d 70 6c 65 74 65 22 2c 22 74 6f 74  |:"complete","tot|
000002f0  61 6c 5f 74 6f 6b 65 6e 73 22 3a 31 35 2c 22 69  |al_tokens":15,"i|
00000300  6e 70 75 74 22 3a 7b 22 74 6f 74 61 6c 5f 74 6f  |nput":{"total_to|
00000310  6b 65 6e 73 22 3a 39 2c 22 75 6e 63 61 63 68 65  |kens":9,"uncache|
00000320  64 5f 74 6f 6b 65 6e 73 22 3a 39 2c 22 63 61 63  |d_tokens":9,"cac|
00000330  68 65 5f 72 65 61 64 5f 74 6f 6b 65 6e 73 22 3a  |he_read_tokens":|
00000340  30 2c 22 63 61 63 68 65 5f 77 72 69 74 65 5f 74  |0,"cache_write_t|
00000350  6f 6b 65 6e 73 22 3a 30 7d 2c 22 6f 75 74 70 75  |okens":0},"outpu|
00000360  74 22 3a 7b 22 74 6f 74 61 6c 5f 74 6f 6b 65 6e  |t":{"total_token|
00000370  73 22 3a 36 2c 22 6e 6f 6e 5f 72 65 61 73 6f 6e  |s":6,"non_reason|
00000380  69 6e 67 5f 74 6f 6b 65 6e 73 22 3a 36 2c 22 72  |ing_tokens":6,"r|
00000390  65 61 73 6f 6e 69 6e 67 5f 74 6f 6b 65 6e 73 22  |easoning_tokens"|
000003a0  3a 30 7d 2c 22 75 6e 63 6c 61 73 73 69 66 69 65  |:0},"unclassifie|
000003b0  64 5f 74 6f 6b 65 6e 73 22 3a 30 7d 2c 22 70 72  |d_tokens":0},"pr|
000003c0  6f 76 69 64 65 72 22 3a 22 6f 70 65 6e 61 69 2d  |ovider":"openai-|
000003d0  63 6f 6d 70 61 74 69 62 6c 65 2d 6d 6f 63 6b 2d  |compatible-mock-|
000003e0  6f 70 65 6e 61 69 22 2c 22 65 78 65 63 75 74 6f  |openai","executo|
000003f0  72 5f 74 79 70 65 22 3a 22 4f 70 65 6e 41 49 43  |r_type":"OpenAIC|
00000400  6f 6d 70 61 74 45 78 65 63 75 74 6f 72 22 2c 22  |ompatExecutor","|
00000410  6d 6f 64 65 6c 22 3a 22 6d 6f 63 6b 2d 67 70 74  |model":"mock-gpt|
00000420  2d 6d 6f 64 65 6c 22 2c 22 61 6c 69 61 73 22 3a  |-model","alias":|
00000430  22 6d 6f 63 6b 2d 6d 6f 64 65 6c 22 2c 22 65 6e  |"mock-model","en|
00000440  64 70 6f 69 6e 74 22 3a 22 50 4f 53 54 20 2f 76  |dpoint":"POST /v|
00000450  31 2f 63 68 61 74 2f 63 6f 6d 70 6c 65 74 69 6f  |1/chat/completio|
00000460  6e 73 22 2c 22 61 75 74 68 5f 74 79 70 65 22 3a  |ns","auth_type":|
00000470  22 61 70 69 6b 65 79 22 2c 22 61 70 69 5f 6b 65  |"apikey","api_ke|
00000480  79 22 3a 22 6f 72 61 63 6c 65 2d 6c 6f 63 61 6c  |y":"oracle-local|
00000490  2d 6b 65 79 2d 31 22 2c 22 72 65 71 75 65 73 74  |-key-1","request|
000004a0  5f 69 64 22 3a 22 30 65 64 61 65 39 65 33 22 2c  |_id":"0edae9e3",|
000004b0  22 73 65 73 73 69 6f 6e 5f 69 64 22 3a 22 35 36  |"session_id":"56|
000004c0  64 66 30 33 30 62 2d 37 66 35 32 2d 38 38 36 66  |df030b-7f52-886f|
000004d0  2d 39 64 37 64 2d 35 31 30 38 33 62 30 32 64 64  |-9d7d-51083b02dd|
000004e0  33 62 22 2c 22 72 65 61 73 6f 6e 69 6e 67 5f 65  |3b","reasoning_e|
000004f0  66 66 6f 72 74 22 3a 22 22 2c 22 73 65 72 76 69  |ffort":"","servi|
00000500  63 65 5f 74 69 65 72 22 3a 22 61 75 74 6f 22 7d  |ce_tier":"auto"}|
00000510  0d 0a 24 31 32 38 30 0d 0a 7b 22 74 69 6d 65 73  |..$1280..{"times|
00000520  74 61 6d 70 22 3a 22 32 30 32 36 2d 30 39 2d 31  |tamp":"2026-09-1|
00000530  36 54 30 31 3a 32 30 3a 31 35 2e 38 34 38 32 34  |6T01:20:15.84824|
00000540  38 36 37 34 2b 30 38 3a 30 30 22 2c 22 6c 61 74  |8674+08:00","lat|
00000550  65 6e 63 79 5f 6d 73 22 3a 31 2c 22 74 74 66 74  |ency_ms":1,"ttft|
00000560  5f 6d 73 22 3a 31 2c 22 73 6f 75 72 63 65 22 3a  |_ms":1,"source":|
00000570  22 6d 6f 63 6b 2d 75 70 73 74 72 65 61 6d 2d 6b  |"mock-upstream-k|
00000580  65 79 22 2c 22 61 75 74 68 5f 69 6e 64 65 78 22  |ey","auth_index"|
00000590  3a 22 34 37 38 62 30 30 38 34 38 39 35 33 38 64  |:"478b008489538d|
000005a0  32 38 22 2c 22 63 6c 69 65 6e 74 5f 69 70 22 3a  |28","client_ip":|
000005b0  22 31 37 32 2e 31 37 2e 30 2e 31 22 2c 22 78 5f  |"172.17.0.1","x_|
000005c0  66 6f 72 77 61 72 64 65 64 5f 66 6f 72 22 3a 22  |forwarded_for":"|
000005d0  22 2c 22 75 73 65 72 5f 61 67 65 6e 74 22 3a 22  |","user_agent":"|
000005e0  6f 72 61 63 6c 65 2d 73 33 2d 70 72 6f 62 65 2f  |oracle-s3-probe/|
000005f0  31 2e 30 22 2c 22 74 6f 6b 65 6e 73 22 3a 7b 22  |1.0","tokens":{"|
00000600  69 6e 70 75 74 5f 74 6f 6b 65 6e 73 22 3a 39 2c  |input_tokens":9,|
00000610  22 6f 75 74 70 75 74 5f 74 6f 6b 65 6e 73 22 3a  |"output_tokens":|
00000620  36 2c 22 72 65 61 73 6f 6e 69 6e 67 5f 74 6f 6b  |6,"reasoning_tok|
00000630  65 6e 73 22 3a 30 2c 22 63 61 63 68 65 64 5f 74  |ens":0,"cached_t|
00000640  6f 6b 65 6e 73 22 3a 30 2c 22 63 61 63 68 65 5f  |okens":0,"cache_|
00000650  72 65 61 64 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22  |read_tokens":0,"|
00000660  63 61 63 68 65 5f 72 65 61 64 5f 74 6f 6b 65 6e  |cache_read_token|
00000670  73 5f 70 72 65 73 65 6e 74 22 3a 74 72 75 65 2c  |s_present":true,|
00000680  22 63 61 63 68 65 5f 63 72 65 61 74 69 6f 6e 5f  |"cache_creation_|
00000690  74 6f 6b 65 6e 73 22 3a 30 2c 22 74 6f 74 61 6c  |tokens":0,"total|
000006a0  5f 74 6f 6b 65 6e 73 22 3a 31 35 7d 2c 22 66 61  |_tokens":15},"fa|
000006b0  69 6c 65 64 22 3a 66 61 6c 73 65 2c 22 67 65 6e  |iled":false,"gen|
000006c0  65 72 61 74 65 22 3a 74 72 75 65 2c 22 73 74 72  |erate":true,"str|
000006d0  65 61 6d 22 3a 66 61 6c 73 65 2c 22 66 61 69 6c  |eam":false,"fail|
000006e0  22 3a 7b 22 73 74 61 74 75 73 5f 63 6f 64 65 22  |":{"status_code"|
000006f0  3a 32 30 30 2c 22 62 6f 64 79 22 3a 22 22 7d 2c  |:200,"body":""},|
00000700  22 72 65 73 70 6f 6e 73 65 5f 68 65 61 64 65 72  |"response_header|
00000710  73 22 3a 7b 22 43 6f 6e 74 65 6e 74 2d 4c 65 6e  |s":{"Content-Len|
00000720  67 74 68 22 3a 5b 22 33 31 39 22 5d 2c 22 43 6f  |gth":["319"],"Co|
00000730  6e 74 65 6e 74 2d 54 79 70 65 22 3a 5b 22 61 70  |ntent-Type":["ap|
00000740  70 6c 69 63 61 74 69 6f 6e 2f 6a 73 6f 6e 22 5d  |plication/json"]|
00000750  2c 22 44 61 74 65 22 3a 5b 22 54 75 65 2c 20 31  |,"Date":["Tue, 1|
00000760  35 20 53 65 70 20 32 30 32 36 20 31 37 3a 32 30  |5 Sep 2026 17:20|
00000770  3a 31 35 20 47 4d 54 22 5d 2c 22 53 65 72 76 65  |:15 GMT"],"Serve|
00000780  72 22 3a 5b 22 42 61 73 65 48 54 54 50 2f 30 2e  |r":["BaseHTTP/0.|
00000790  36 20 50 79 74 68 6f 6e 2f 33 2e 31 34 2e 36 22  |6 Python/3.14.6"|
000007a0  5d 7d 2c 22 61 63 63 6f 75 6e 74 69 6e 67 5f 76  |]},"accounting_v|
000007b0  65 72 73 69 6f 6e 22 3a 32 2c 22 74 6f 6b 65 6e  |ersion":2,"token|
000007c0  5f 62 72 65 61 6b 64 6f 77 6e 22 3a 7b 22 73 63  |_breakdown":{"sc|
000007d0  68 65 6d 61 5f 76 65 72 73 69 6f 6e 22 3a 32 2c  |hema_version":2,|
000007e0  22 71 75 61 6c 69 74 79 22 3a 22 63 6f 6d 70 6c  |"quality":"compl|
000007f0  65 74 65 22 2c 22 74 6f 74 61 6c 5f 74 6f 6b 65  |ete","total_toke|
00000800  6e 73 22 3a 31 35 2c 22 69 6e 70 75 74 22 3a 7b  |ns":15,"input":{|
00000810  22 74 6f 74 61 6c 5f 74 6f 6b 65 6e 73 22 3a 39  |"total_tokens":9|
00000820  2c 22 75 6e 63 61 63 68 65 64 5f 74 6f 6b 65 6e  |,"uncached_token|
00000830  73 22 3a 39 2c 22 63 61 63 68 65 5f 72 65 61 64  |s":9,"cache_read|
00000840  5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63 61 63 68  |_tokens":0,"cach|
00000850  65 5f 77 72 69 74 65 5f 74 6f 6b 65 6e 73 22 3a  |e_write_tokens":|
00000860  30 7d 2c 22 6f 75 74 70 75 74 22 3a 7b 22 74 6f  |0},"output":{"to|
00000870  74 61 6c 5f 74 6f 6b 65 6e 73 22 3a 36 2c 22 6e  |tal_tokens":6,"n|
00000880  6f 6e 5f 72 65 61 73 6f 6e 69 6e 67 5f 74 6f 6b  |on_reasoning_tok|
00000890  65 6e 73 22 3a 36 2c 22 72 65 61 73 6f 6e 69 6e  |ens":6,"reasonin|
000008a0  67 5f 74 6f 6b 65 6e 73 22 3a 30 7d 2c 22 75 6e  |g_tokens":0},"un|
000008b0  63 6c 61 73 73 69 66 69 65 64 5f 74 6f 6b 65 6e  |classified_token|
000008c0  73 22 3a 30 7d 2c 22 70 72 6f 76 69 64 65 72 22  |s":0},"provider"|
000008d0  3a 22 6f 70 65 6e 61 69 2d 63 6f 6d 70 61 74 69  |:"openai-compati|
000008e0  62 6c 65 2d 6d 6f 63 6b 2d 6f 70 65 6e 61 69 22  |ble-mock-openai"|
000008f0  2c 22 65 78 65 63 75 74 6f 72 5f 74 79 70 65 22  |,"executor_type"|
00000900  3a 22 4f 70 65 6e 41 49 43 6f 6d 70 61 74 45 78  |:"OpenAICompatEx|
00000910  65 63 75 74 6f 72 22 2c 22 6d 6f 64 65 6c 22 3a  |ecutor","model":|
00000920  22 6d 6f 63 6b 2d 67 70 74 2d 6d 6f 64 65 6c 22  |"mock-gpt-model"|
00000930  2c 22 61 6c 69 61 73 22 3a 22 6d 6f 63 6b 2d 6d  |,"alias":"mock-m|
00000940  6f 64 65 6c 22 2c 22 65 6e 64 70 6f 69 6e 74 22  |odel","endpoint"|
00000950  3a 22 50 4f 53 54 20 2f 76 31 2f 63 68 61 74 2f  |:"POST /v1/chat/|
00000960  63 6f 6d 70 6c 65 74 69 6f 6e 73 22 2c 22 61 75  |completions","au|
00000970  74 68 5f 74 79 70 65 22 3a 22 61 70 69 6b 65 79  |th_type":"apikey|
00000980  22 2c 22 61 70 69 5f 6b 65 79 22 3a 22 6f 72 61  |","api_key":"ora|
00000990  63 6c 65 2d 6c 6f 63 61 6c 2d 6b 65 79 2d 31 22  |cle-local-key-1"|
000009a0  2c 22 72 65 71 75 65 73 74 5f 69 64 22 3a 22 61  |,"request_id":"a|
000009b0  66 66 32 65 39 31 31 22 2c 22 73 65 73 73 69 6f  |ff2e911","sessio|
000009c0  6e 5f 69 64 22 3a 22 35 36 64 66 30 33 30 62 2d  |n_id":"56df030b-|
000009d0  37 66 35 32 2d 38 38 36 66 2d 39 64 37 64 2d 35  |7f52-886f-9d7d-5|
000009e0  31 30 38 33 62 30 32 64 64 33 62 22 2c 22 72 65  |1083b02dd3b","re|
000009f0  61 73 6f 6e 69 6e 67 5f 65 66 66 6f 72 74 22 3a  |asoning_effort":|
00000a00  22 22 2c 22 73 65 72 76 69 63 65 5f 74 69 65 72  |"","service_tier|
00000a10  22 3a 22 61 75 74 6f 22 7d 0d 0a 24 2d 31 0d 0a  |":"auto"}..$-1..|
00000a20  2a 30 0d 0a 2d 45 52 52 20 75 6e 73 75 70 70 6f  |*0..-ERR unsuppo|
00000a30  72 74 65 64 20 63 68 61 6e 6e 65 6c 20 27 65 72  |rted channel 'er|
00000a40  72 6f 72 73 27 0d 0a 2d 45 52 52 20 75 6e 6b 6e  |rors'..-ERR unkn|
00000a50  6f 77 6e 20 63 6f 6d 6d 61 6e 64 20 27 66 6f 6f  |own command 'foo|
00000a60  27 0d 0a 2d 45 52 52 20 75 6e 6b 6e 6f 77 6e 20  |'..-ERR unknown |
00000a70  63 6f 6d 6d 61 6e 64 20 27 71 75 69 74 27 0d 0a  |command 'quit'..|
```
literal (escaped):
```
+OK\r\n*2\r\n$1280\r\n{"timestamp":"2026-09-16T01:20:15.842871465+08:00","latency_ms":1,"ttft_ms":1,"source":"mock-upstream-key","auth_index":"478b008489538d28","client_ip":"172.17.0.1","x_forwarded_for":"","user_agent":"oracle-s3-probe/1.0","tokens":{"input_tokens":9,"output_tokens":6,"reasoning_tokens":0,"cached_tokens":0,"cache_read_tokens":0,"cache_read_tokens_present":true,"cache_creation_tokens":0,"total_tokens":15},"failed":false,"generate":true,"stream":false,"fail":{"status_code":200,"body":""},"response_headers":{"Content-Length":["319"],"Content-Type":["application/json"],"Date":["Tue, 15 Sep 2026 17:20:15 GMT"],"Server":["BaseHTTP/0.6 Python/3.14.6"]},"accounting_version":2,"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":15,"input":{"total_tokens":9,"uncached_tokens":9,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":6,"non_reasoning_tokens":6,"reasoning_tokens":0},"unclassified_tokens":0},"provider":"openai-compatible-mock-openai","executor_type":"OpenAICompatExecutor","model":"mock-gpt-model","alias":"mock-model","endpoint":"POST /v1/chat/completions","auth_type":"apikey","api_key":"oracle-local-key-1","request_id":"0edae9e3","session_id":"56df030b-7f52-886f-9d7d-51083b02dd3b","reasoning_effort":"","service_tier":"auto"}\r\n$1280\r\n{"timestamp":"2026-09-16T01:20:15.848248674+08:00","latency_ms":1,"ttft_ms":1,"source":"mock-upstream-key","auth_index":"478b008489538d28","client_ip":"172.17.0.1","x_forwarded_for":"","user_agent":"oracle-s3-probe/1.0","tokens":{"input_tokens":9,"output_tokens":6,"reasoning_tokens":0,"cached_tokens":0,"cache_read_tokens":0,"cache_read_tokens_present":true,"cache_creation_tokens":0,"total_tokens":15},"failed":false,"generate":true,"stream":false,"fail":{"status_code":200,"body":""},"response_headers":{"Content-Length":["319"],"Content-Type":["application/json"],"Date":["Tue, 15 Sep 2026 17:20:15 GMT"],"Server":["BaseHTTP/0.6 Python/3.14.6"]},"accounting_version":2,"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":15,"input":{"total_tokens":9,"uncached_tokens":9,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":6,"non_reasoning_tokens":6,"reasoning_tokens":0},"unclassified_tokens":0},"provider":"openai-compatible-mock-openai","executor_type":"OpenAICompatExecutor","model":"mock-gpt-model","alias":"mock-model","endpoint":"POST /v1/chat/completions","auth_type":"apikey","api_key":"oracle-local-key-1","request_id":"aff2e911","session_id":"56df030b-7f52-886f-9d7d-51083b02dd3b","reasoning_effort":"","service_tier":"auto"}\r\n$-1\r\n*0\r\n-ERR unsupported channel 'errors'\r\n-ERR unknown command 'foo'\r\n-ERR unknown command 'quit'\r\n
```

## conn 4 — follow-up — 29 bytes received
```
00000000  2d 45 52 52 20 69 6e 76 61 6c 69 64 20 6d 61 6e  |-ERR invalid man|
00000010  61 67 65 6d 65 6e 74 20 6b 65 79 0d 0a           |agement key..|
```
literal (escaped):
```
-ERR invalid management key\r\n
```
