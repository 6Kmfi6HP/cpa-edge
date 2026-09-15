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

## conn 3 — AUTH + LPOP/RPOP + errors channel + unknown + QUIT — 2916 bytes received
```
00000000  2b 4f 4b 0d 0a 2a 32 0d 0a 24 31 33 39 34 0d 0a  |+OK..*2..$1394..|
00000010  7b 22 74 69 6d 65 73 74 61 6d 70 22 3a 22 32 30  |{"timestamp":"20|
00000020  32 36 2d 30 39 2d 31 36 54 30 31 3a 31 37 3a 30  |26-09-16T01:17:0|
00000030  34 2e 39 33 36 33 36 37 31 32 37 2b 30 38 3a 30  |4.936367127+08:0|
00000040  30 22 2c 22 6c 61 74 65 6e 63 79 5f 6d 73 22 3a  |0","latency_ms":|
00000050  32 2c 22 74 74 66 74 5f 6d 73 22 3a 32 2c 22 73  |2,"ttft_ms":2,"s|
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
00000100  65 6e 73 22 3a 30 2c 22 6f 75 74 70 75 74 5f 74  |ens":0,"output_t|
00000110  6f 6b 65 6e 73 22 3a 30 2c 22 72 65 61 73 6f 6e  |okens":0,"reason|
00000120  69 6e 67 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63  |ing_tokens":0,"c|
00000130  61 63 68 65 64 5f 74 6f 6b 65 6e 73 22 3a 30 2c  |ached_tokens":0,|
00000140  22 63 61 63 68 65 5f 72 65 61 64 5f 74 6f 6b 65  |"cache_read_toke|
00000150  6e 73 22 3a 30 2c 22 63 61 63 68 65 5f 72 65 61  |ns":0,"cache_rea|
00000160  64 5f 74 6f 6b 65 6e 73 5f 70 72 65 73 65 6e 74  |d_tokens_present|
00000170  22 3a 74 72 75 65 2c 22 63 61 63 68 65 5f 63 72  |":true,"cache_cr|
00000180  65 61 74 69 6f 6e 5f 74 6f 6b 65 6e 73 22 3a 30  |eation_tokens":0|
00000190  2c 22 74 6f 74 61 6c 5f 74 6f 6b 65 6e 73 22 3a  |,"total_tokens":|
000001a0  30 7d 2c 22 66 61 69 6c 65 64 22 3a 74 72 75 65  |0},"failed":true|
000001b0  2c 22 67 65 6e 65 72 61 74 65 22 3a 74 72 75 65  |,"generate":true|
000001c0  2c 22 73 74 72 65 61 6d 22 3a 66 61 6c 73 65 2c  |,"stream":false,|
000001d0  22 66 61 69 6c 22 3a 7b 22 73 74 61 74 75 73 5f  |"fail":{"status_|
000001e0  63 6f 64 65 22 3a 35 30 30 2c 22 62 6f 64 79 22  |code":500,"body"|
000001f0  3a 22 7b 5c 22 65 72 72 6f 72 5c 22 3a 20 7b 5c  |:"{\"error\": {\|
00000200  22 6d 65 73 73 61 67 65 5c 22 3a 20 5c 22 6d 6f  |"message\": \"mo|
00000210  63 6b 20 72 61 74 65 20 6c 69 6d 69 74 5c 22 2c  |ck rate limit\",|
00000220  20 5c 22 74 79 70 65 5c 22 3a 20 5c 22 72 61 74  | \"type\": \"rat|
00000230  65 5f 6c 69 6d 69 74 5f 65 78 63 65 65 64 65 64  |e_limit_exceeded|
00000240  5c 22 2c 20 5c 22 63 6f 64 65 5c 22 3a 20 5c 22  |\", \"code\": \"|
00000250  72 61 74 65 5f 6c 69 6d 69 74 5f 65 78 63 65 65  |rate_limit_excee|
00000260  64 65 64 5c 22 7d 7d 22 7d 2c 22 72 65 73 70 6f  |ded\"}}"},"respo|
00000270  6e 73 65 5f 68 65 61 64 65 72 73 22 3a 7b 22 43  |nse_headers":{"C|
00000280  6f 6e 74 65 6e 74 2d 4c 65 6e 67 74 68 22 3a 5b  |ontent-Length":[|
00000290  22 31 30 33 22 5d 2c 22 43 6f 6e 74 65 6e 74 2d  |"103"],"Content-|
000002a0  54 79 70 65 22 3a 5b 22 61 70 70 6c 69 63 61 74  |Type":["applicat|
000002b0  69 6f 6e 2f 6a 73 6f 6e 22 5d 2c 22 44 61 74 65  |ion/json"],"Date|
000002c0  22 3a 5b 22 54 75 65 2c 20 31 35 20 53 65 70 20  |":["Tue, 15 Sep |
000002d0  32 30 32 36 20 31 37 3a 31 37 3a 30 34 20 47 4d  |2026 17:17:04 GM|
000002e0  54 22 5d 2c 22 53 65 72 76 65 72 22 3a 5b 22 42  |T"],"Server":["B|
000002f0  61 73 65 48 54 54 50 2f 30 2e 36 20 50 79 74 68  |aseHTTP/0.6 Pyth|
00000300  6f 6e 2f 33 2e 31 34 2e 36 22 5d 7d 2c 22 61 63  |on/3.14.6"]},"ac|
00000310  63 6f 75 6e 74 69 6e 67 5f 76 65 72 73 69 6f 6e  |counting_version|
00000320  22 3a 32 2c 22 74 6f 6b 65 6e 5f 62 72 65 61 6b  |":2,"token_break|
00000330  64 6f 77 6e 22 3a 7b 22 73 63 68 65 6d 61 5f 76  |down":{"schema_v|
00000340  65 72 73 69 6f 6e 22 3a 32 2c 22 71 75 61 6c 69  |ersion":2,"quali|
00000350  74 79 22 3a 22 63 6f 6d 70 6c 65 74 65 22 2c 22  |ty":"complete","|
00000360  74 6f 74 61 6c 5f 74 6f 6b 65 6e 73 22 3a 30 2c  |total_tokens":0,|
00000370  22 69 6e 70 75 74 22 3a 7b 22 74 6f 74 61 6c 5f  |"input":{"total_|
00000380  74 6f 6b 65 6e 73 22 3a 30 2c 22 75 6e 63 61 63  |tokens":0,"uncac|
00000390  68 65 64 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63  |hed_tokens":0,"c|
000003a0  61 63 68 65 5f 72 65 61 64 5f 74 6f 6b 65 6e 73  |ache_read_tokens|
000003b0  22 3a 30 2c 22 63 61 63 68 65 5f 77 72 69 74 65  |":0,"cache_write|
000003c0  5f 74 6f 6b 65 6e 73 22 3a 30 7d 2c 22 6f 75 74  |_tokens":0},"out|
000003d0  70 75 74 22 3a 7b 22 74 6f 74 61 6c 5f 74 6f 6b  |put":{"total_tok|
000003e0  65 6e 73 22 3a 30 2c 22 6e 6f 6e 5f 72 65 61 73  |ens":0,"non_reas|
000003f0  6f 6e 69 6e 67 5f 74 6f 6b 65 6e 73 22 3a 30 2c  |oning_tokens":0,|
00000400  22 72 65 61 73 6f 6e 69 6e 67 5f 74 6f 6b 65 6e  |"reasoning_token|
00000410  73 22 3a 30 7d 2c 22 75 6e 63 6c 61 73 73 69 66  |s":0},"unclassif|
00000420  69 65 64 5f 74 6f 6b 65 6e 73 22 3a 30 7d 2c 22  |ied_tokens":0},"|
00000430  70 72 6f 76 69 64 65 72 22 3a 22 6f 70 65 6e 61  |provider":"opena|
00000440  69 2d 63 6f 6d 70 61 74 69 62 6c 65 2d 6d 6f 63  |i-compatible-moc|
00000450  6b 2d 6f 70 65 6e 61 69 22 2c 22 65 78 65 63 75  |k-openai","execu|
00000460  74 6f 72 5f 74 79 70 65 22 3a 22 4f 70 65 6e 41  |tor_type":"OpenA|
00000470  49 43 6f 6d 70 61 74 45 78 65 63 75 74 6f 72 22  |ICompatExecutor"|
00000480  2c 22 6d 6f 64 65 6c 22 3a 22 6d 6f 63 6b 2d 67  |,"model":"mock-g|
00000490  70 74 2d 6d 6f 64 65 6c 22 2c 22 61 6c 69 61 73  |pt-model","alias|
000004a0  22 3a 22 6d 6f 63 6b 2d 6d 6f 64 65 6c 22 2c 22  |":"mock-model","|
000004b0  65 6e 64 70 6f 69 6e 74 22 3a 22 50 4f 53 54 20  |endpoint":"POST |
000004c0  2f 76 31 2f 63 68 61 74 2f 63 6f 6d 70 6c 65 74  |/v1/chat/complet|
000004d0  69 6f 6e 73 22 2c 22 61 75 74 68 5f 74 79 70 65  |ions","auth_type|
000004e0  22 3a 22 61 70 69 6b 65 79 22 2c 22 61 70 69 5f  |":"apikey","api_|
000004f0  6b 65 79 22 3a 22 6f 72 61 63 6c 65 2d 6c 6f 63  |key":"oracle-loc|
00000500  61 6c 2d 6b 65 79 2d 31 22 2c 22 72 65 71 75 65  |al-key-1","reque|
00000510  73 74 5f 69 64 22 3a 22 31 32 30 63 63 63 61 61  |st_id":"120cccaa|
00000520  22 2c 22 73 65 73 73 69 6f 6e 5f 69 64 22 3a 22  |","session_id":"|
00000530  35 36 64 66 30 33 30 62 2d 37 66 35 32 2d 38 38  |56df030b-7f52-88|
00000540  36 66 2d 39 64 37 64 2d 35 31 30 38 33 62 30 32  |6f-9d7d-51083b02|
00000550  64 64 33 62 22 2c 22 72 65 61 73 6f 6e 69 6e 67  |dd3b","reasoning|
00000560  5f 65 66 66 6f 72 74 22 3a 22 22 2c 22 73 65 72  |_effort":"","ser|
00000570  76 69 63 65 5f 74 69 65 72 22 3a 22 61 75 74 6f  |vice_tier":"auto|
00000580  22 7d 0d 0a 24 31 33 39 34 0d 0a 7b 22 74 69 6d  |"}..$1394..{"tim|
00000590  65 73 74 61 6d 70 22 3a 22 32 30 32 36 2d 30 39  |estamp":"2026-09|
000005a0  2d 31 36 54 30 31 3a 31 37 3a 30 34 2e 39 34 36  |-16T01:17:04.946|
000005b0  30 34 38 35 38 35 2b 30 38 3a 30 30 22 2c 22 6c  |048585+08:00","l|
000005c0  61 74 65 6e 63 79 5f 6d 73 22 3a 32 2c 22 74 74  |atency_ms":2,"tt|
000005d0  66 74 5f 6d 73 22 3a 32 2c 22 73 6f 75 72 63 65  |ft_ms":2,"source|
000005e0  22 3a 22 6d 6f 63 6b 2d 75 70 73 74 72 65 61 6d  |":"mock-upstream|
000005f0  2d 6b 65 79 22 2c 22 61 75 74 68 5f 69 6e 64 65  |-key","auth_inde|
00000600  78 22 3a 22 34 37 38 62 30 30 38 34 38 39 35 33  |x":"478b00848953|
00000610  38 64 32 38 22 2c 22 63 6c 69 65 6e 74 5f 69 70  |8d28","client_ip|
00000620  22 3a 22 31 37 32 2e 31 37 2e 30 2e 31 22 2c 22  |":"172.17.0.1","|
00000630  78 5f 66 6f 72 77 61 72 64 65 64 5f 66 6f 72 22  |x_forwarded_for"|
00000640  3a 22 22 2c 22 75 73 65 72 5f 61 67 65 6e 74 22  |:"","user_agent"|
00000650  3a 22 6f 72 61 63 6c 65 2d 73 33 2d 70 72 6f 62  |:"oracle-s3-prob|
00000660  65 2f 31 2e 30 22 2c 22 74 6f 6b 65 6e 73 22 3a  |e/1.0","tokens":|
00000670  7b 22 69 6e 70 75 74 5f 74 6f 6b 65 6e 73 22 3a  |{"input_tokens":|
00000680  30 2c 22 6f 75 74 70 75 74 5f 74 6f 6b 65 6e 73  |0,"output_tokens|
00000690  22 3a 30 2c 22 72 65 61 73 6f 6e 69 6e 67 5f 74  |":0,"reasoning_t|
000006a0  6f 6b 65 6e 73 22 3a 30 2c 22 63 61 63 68 65 64  |okens":0,"cached|
000006b0  5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 63 61 63 68  |_tokens":0,"cach|
000006c0  65 5f 72 65 61 64 5f 74 6f 6b 65 6e 73 22 3a 30  |e_read_tokens":0|
000006d0  2c 22 63 61 63 68 65 5f 72 65 61 64 5f 74 6f 6b  |,"cache_read_tok|
000006e0  65 6e 73 5f 70 72 65 73 65 6e 74 22 3a 74 72 75  |ens_present":tru|
000006f0  65 2c 22 63 61 63 68 65 5f 63 72 65 61 74 69 6f  |e,"cache_creatio|
00000700  6e 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 74 6f 74  |n_tokens":0,"tot|
00000710  61 6c 5f 74 6f 6b 65 6e 73 22 3a 30 7d 2c 22 66  |al_tokens":0},"f|
00000720  61 69 6c 65 64 22 3a 74 72 75 65 2c 22 67 65 6e  |ailed":true,"gen|
00000730  65 72 61 74 65 22 3a 74 72 75 65 2c 22 73 74 72  |erate":true,"str|
00000740  65 61 6d 22 3a 66 61 6c 73 65 2c 22 66 61 69 6c  |eam":false,"fail|
00000750  22 3a 7b 22 73 74 61 74 75 73 5f 63 6f 64 65 22  |":{"status_code"|
00000760  3a 35 30 30 2c 22 62 6f 64 79 22 3a 22 7b 5c 22  |:500,"body":"{\"|
00000770  65 72 72 6f 72 5c 22 3a 20 7b 5c 22 6d 65 73 73  |error\": {\"mess|
00000780  61 67 65 5c 22 3a 20 5c 22 6d 6f 63 6b 20 72 61  |age\": \"mock ra|
00000790  74 65 20 6c 69 6d 69 74 5c 22 2c 20 5c 22 74 79  |te limit\", \"ty|
000007a0  70 65 5c 22 3a 20 5c 22 72 61 74 65 5f 6c 69 6d  |pe\": \"rate_lim|
000007b0  69 74 5f 65 78 63 65 65 64 65 64 5c 22 2c 20 5c  |it_exceeded\", \|
000007c0  22 63 6f 64 65 5c 22 3a 20 5c 22 72 61 74 65 5f  |"code\": \"rate_|
000007d0  6c 69 6d 69 74 5f 65 78 63 65 65 64 65 64 5c 22  |limit_exceeded\"|
000007e0  7d 7d 22 7d 2c 22 72 65 73 70 6f 6e 73 65 5f 68  |}}"},"response_h|
000007f0  65 61 64 65 72 73 22 3a 7b 22 43 6f 6e 74 65 6e  |eaders":{"Conten|
00000800  74 2d 4c 65 6e 67 74 68 22 3a 5b 22 31 30 33 22  |t-Length":["103"|
00000810  5d 2c 22 43 6f 6e 74 65 6e 74 2d 54 79 70 65 22  |],"Content-Type"|
00000820  3a 5b 22 61 70 70 6c 69 63 61 74 69 6f 6e 2f 6a  |:["application/j|
00000830  73 6f 6e 22 5d 2c 22 44 61 74 65 22 3a 5b 22 54  |son"],"Date":["T|
00000840  75 65 2c 20 31 35 20 53 65 70 20 32 30 32 36 20  |ue, 15 Sep 2026 |
00000850  31 37 3a 31 37 3a 30 34 20 47 4d 54 22 5d 2c 22  |17:17:04 GMT"],"|
00000860  53 65 72 76 65 72 22 3a 5b 22 42 61 73 65 48 54  |Server":["BaseHT|
00000870  54 50 2f 30 2e 36 20 50 79 74 68 6f 6e 2f 33 2e  |TP/0.6 Python/3.|
00000880  31 34 2e 36 22 5d 7d 2c 22 61 63 63 6f 75 6e 74  |14.6"]},"account|
00000890  69 6e 67 5f 76 65 72 73 69 6f 6e 22 3a 32 2c 22  |ing_version":2,"|
000008a0  74 6f 6b 65 6e 5f 62 72 65 61 6b 64 6f 77 6e 22  |token_breakdown"|
000008b0  3a 7b 22 73 63 68 65 6d 61 5f 76 65 72 73 69 6f  |:{"schema_versio|
000008c0  6e 22 3a 32 2c 22 71 75 61 6c 69 74 79 22 3a 22  |n":2,"quality":"|
000008d0  63 6f 6d 70 6c 65 74 65 22 2c 22 74 6f 74 61 6c  |complete","total|
000008e0  5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 69 6e 70 75  |_tokens":0,"inpu|
000008f0  74 22 3a 7b 22 74 6f 74 61 6c 5f 74 6f 6b 65 6e  |t":{"total_token|
00000900  73 22 3a 30 2c 22 75 6e 63 61 63 68 65 64 5f 74  |s":0,"uncached_t|
00000910  6f 6b 65 6e 73 22 3a 30 2c 22 63 61 63 68 65 5f  |okens":0,"cache_|
00000920  72 65 61 64 5f 74 6f 6b 65 6e 73 22 3a 30 2c 22  |read_tokens":0,"|
00000930  63 61 63 68 65 5f 77 72 69 74 65 5f 74 6f 6b 65  |cache_write_toke|
00000940  6e 73 22 3a 30 7d 2c 22 6f 75 74 70 75 74 22 3a  |ns":0},"output":|
00000950  7b 22 74 6f 74 61 6c 5f 74 6f 6b 65 6e 73 22 3a  |{"total_tokens":|
00000960  30 2c 22 6e 6f 6e 5f 72 65 61 73 6f 6e 69 6e 67  |0,"non_reasoning|
00000970  5f 74 6f 6b 65 6e 73 22 3a 30 2c 22 72 65 61 73  |_tokens":0,"reas|
00000980  6f 6e 69 6e 67 5f 74 6f 6b 65 6e 73 22 3a 30 7d  |oning_tokens":0}|
00000990  2c 22 75 6e 63 6c 61 73 73 69 66 69 65 64 5f 74  |,"unclassified_t|
000009a0  6f 6b 65 6e 73 22 3a 30 7d 2c 22 70 72 6f 76 69  |okens":0},"provi|
000009b0  64 65 72 22 3a 22 6f 70 65 6e 61 69 2d 63 6f 6d  |der":"openai-com|
000009c0  70 61 74 69 62 6c 65 2d 6d 6f 63 6b 2d 6f 70 65  |patible-mock-ope|
000009d0  6e 61 69 22 2c 22 65 78 65 63 75 74 6f 72 5f 74  |nai","executor_t|
000009e0  79 70 65 22 3a 22 4f 70 65 6e 41 49 43 6f 6d 70  |ype":"OpenAIComp|
000009f0  61 74 45 78 65 63 75 74 6f 72 22 2c 22 6d 6f 64  |atExecutor","mod|
00000a00  65 6c 22 3a 22 6d 6f 63 6b 2d 67 70 74 2d 6d 6f  |el":"mock-gpt-mo|
00000a10  64 65 6c 22 2c 22 61 6c 69 61 73 22 3a 22 6d 6f  |del","alias":"mo|
00000a20  63 6b 2d 6d 6f 64 65 6c 22 2c 22 65 6e 64 70 6f  |ck-model","endpo|
00000a30  69 6e 74 22 3a 22 50 4f 53 54 20 2f 76 31 2f 63  |int":"POST /v1/c|
00000a40  68 61 74 2f 63 6f 6d 70 6c 65 74 69 6f 6e 73 22  |hat/completions"|
00000a50  2c 22 61 75 74 68 5f 74 79 70 65 22 3a 22 61 70  |,"auth_type":"ap|
00000a60  69 6b 65 79 22 2c 22 61 70 69 5f 6b 65 79 22 3a  |ikey","api_key":|
00000a70  22 6f 72 61 63 6c 65 2d 6c 6f 63 61 6c 2d 6b 65  |"oracle-local-ke|
00000a80  79 2d 31 22 2c 22 72 65 71 75 65 73 74 5f 69 64  |y-1","request_id|
00000a90  22 3a 22 39 62 61 31 37 31 34 39 22 2c 22 73 65  |":"9ba17149","se|
00000aa0  73 73 69 6f 6e 5f 69 64 22 3a 22 35 36 64 66 30  |ssion_id":"56df0|
00000ab0  33 30 62 2d 37 66 35 32 2d 38 38 36 66 2d 39 64  |30b-7f52-886f-9d|
00000ac0  37 64 2d 35 31 30 38 33 62 30 32 64 64 33 62 22  |7d-51083b02dd3b"|
00000ad0  2c 22 72 65 61 73 6f 6e 69 6e 67 5f 65 66 66 6f  |,"reasoning_effo|
00000ae0  72 74 22 3a 22 22 2c 22 73 65 72 76 69 63 65 5f  |rt":"","service_|
00000af0  74 69 65 72 22 3a 22 61 75 74 6f 22 7d 0d 0a 24  |tier":"auto"}..$|
00000b00  2d 31 0d 0a 2a 30 0d 0a 2d 45 52 52 20 75 6e 73  |-1..*0..-ERR uns|
00000b10  75 70 70 6f 72 74 65 64 20 63 68 61 6e 6e 65 6c  |upported channel|
00000b20  20 27 65 72 72 6f 72 73 27 0d 0a 2d 45 52 52 20  | 'errors'..-ERR |
00000b30  75 6e 6b 6e 6f 77 6e 20 63 6f 6d 6d 61 6e 64 20  |unknown command |
00000b40  27 66 6f 6f 27 0d 0a 2d 45 52 52 20 75 6e 6b 6e  |'foo'..-ERR unkn|
00000b50  6f 77 6e 20 63 6f 6d 6d 61 6e 64 20 27 71 75 69  |own command 'qui|
00000b60  74 27 0d 0a                                      |t'..|
```
literal (escaped):
```
+OK\r\n*2\r\n$1394\r\n{"timestamp":"2026-09-16T01:17:04.936367127+08:00","latency_ms":2,"ttft_ms":2,"source":"mock-upstream-key","auth_index":"478b008489538d28","client_ip":"172.17.0.1","x_forwarded_for":"","user_agent":"oracle-s3-probe/1.0","tokens":{"input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cached_tokens":0,"cache_read_tokens":0,"cache_read_tokens_present":true,"cache_creation_tokens":0,"total_tokens":0},"failed":true,"generate":true,"stream":false,"fail":{"status_code":500,"body":"{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}"},"response_headers":{"Content-Length":["103"],"Content-Type":["application/json"],"Date":["Tue, 15 Sep 2026 17:17:04 GMT"],"Server":["BaseHTTP/0.6 Python/3.14.6"]},"accounting_version":2,"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":0,"input":{"total_tokens":0,"uncached_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":0,"non_reasoning_tokens":0,"reasoning_tokens":0},"unclassified_tokens":0},"provider":"openai-compatible-mock-openai","executor_type":"OpenAICompatExecutor","model":"mock-gpt-model","alias":"mock-model","endpoint":"POST /v1/chat/completions","auth_type":"apikey","api_key":"oracle-local-key-1","request_id":"120cccaa","session_id":"56df030b-7f52-886f-9d7d-51083b02dd3b","reasoning_effort":"","service_tier":"auto"}\r\n$1394\r\n{"timestamp":"2026-09-16T01:17:04.946048585+08:00","latency_ms":2,"ttft_ms":2,"source":"mock-upstream-key","auth_index":"478b008489538d28","client_ip":"172.17.0.1","x_forwarded_for":"","user_agent":"oracle-s3-probe/1.0","tokens":{"input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cached_tokens":0,"cache_read_tokens":0,"cache_read_tokens_present":true,"cache_creation_tokens":0,"total_tokens":0},"failed":true,"generate":true,"stream":false,"fail":{"status_code":500,"body":"{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}"},"response_headers":{"Content-Length":["103"],"Content-Type":["application/json"],"Date":["Tue, 15 Sep 2026 17:17:04 GMT"],"Server":["BaseHTTP/0.6 Python/3.14.6"]},"accounting_version":2,"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":0,"input":{"total_tokens":0,"uncached_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":0,"non_reasoning_tokens":0,"reasoning_tokens":0},"unclassified_tokens":0},"provider":"openai-compatible-mock-openai","executor_type":"OpenAICompatExecutor","model":"mock-gpt-model","alias":"mock-model","endpoint":"POST /v1/chat/completions","auth_type":"apikey","api_key":"oracle-local-key-1","request_id":"9ba17149","session_id":"56df030b-7f52-886f-9d7d-51083b02dd3b","reasoning_effort":"","service_tier":"auto"}\r\n$-1\r\n*0\r\n-ERR unsupported channel 'errors'\r\n-ERR unknown command 'foo'\r\n-ERR unknown command 'quit'\r\n
```
