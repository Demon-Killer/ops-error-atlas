export type ErrorRule = {
	id: string;
	matchers: string[];
	category: string;
	title: string;
	meaning: string;
	causes: string[];
	commands: string[];
};

export const errorRules: ErrorRule[] = [
	{
		id: 'connection-reset-by-peer',
		matchers: ['connection reset by peer', 'recv failure: connection was reset'],
		category: 'TCP connection reset',
		title: 'Connection reset by peer',
		meaning:
			'The remote side closed the TCP connection abruptly before your application finished reading or writing data.',
		causes: [
			'The upstream service crashed or restarted.',
			'A load balancer or firewall closed an idle connection.',
			'The client and server disagreed on protocol or timeout settings.',
		],
		commands: ['ss -tanp', 'tcpdump -nn host <peer-ip>', 'journalctl -u <service-name> --since -15m'],
	},
	{
		id: 'broken-pipe',
		matchers: ['broken pipe', 'write epipe'],
		category: 'Write to closed socket',
		title: 'Broken pipe',
		meaning:
			'Your process tried to write data after the remote side had already closed the connection.',
		causes: [
			'The peer timed out while waiting for a response.',
			'An upstream proxy closed the connection early.',
			'The application wrote more data after the client disconnected.',
		],
		commands: ['ss -tan state established', 'lsof -i', 'grep -R "timeout" /etc/nginx /etc/haproxy'],
	},
	{
		id: 'curl-28-operation-timed-out',
		matchers: ['curl: (28)', 'operation timed out'],
		category: 'Request timeout',
		title: 'cURL 28 operation timed out',
		meaning:
			'The request did not complete within the configured timeout window, usually because the network path or upstream service was too slow.',
		causes: [
			'The upstream service is overloaded.',
			'DNS, TLS, or TCP connection setup took too long.',
			'The request timeout is lower than real response latency.',
		],
		commands: ['curl -v <url>', 'dig <host>', 'mtr -rw <host>'],
	},
	{
		id: 'nginx-upstream-timed-out',
		matchers: ['nginx upstream timed out', 'upstream timed out'],
		category: 'Reverse proxy timeout',
		title: 'Nginx upstream timed out',
		meaning:
			'Nginx waited for the upstream application but did not receive response headers or body data before the timeout expired.',
		causes: [
			'The upstream service is slow or blocked.',
			'The upstream worker pool is exhausted.',
			'Nginx timeout settings are too aggressive for this endpoint.',
		],
		commands: ['nginx -T', 'curl -w "@curl-format.txt" -o /dev/null -s <url>', 'top -H -p <pid>'],
	},
	{
		id: 'tls-handshake-failure',
		matchers: ['tls handshake failure', 'ssl routines', 'handshake failure'],
		category: 'TLS negotiation problem',
		title: 'TLS handshake failure',
		meaning:
			'The client and server failed to complete certificate and cipher negotiation before application data could flow.',
		causes: [
			'Certificate validation failed.',
			'The client and server do not share supported protocol versions or cipher suites.',
			'SNI or ALPN configuration is wrong.',
		],
		commands: ['openssl s_client -connect <host>:443 -servername <host>', 'curl -vk https://<host>', 'tcpdump -nn port 443'],
	},
	{
		id: 'connection-refused',
		matchers: ['connection refused', 'connectex: no connection could be made'],
		category: 'Connection setup failed',
		title: 'Connection refused',
		meaning:
			'The TCP SYN reached the target, but no application accepted the connection on that IP and port.',
		causes: [
			'No process is listening on the target port.',
			'The service is bound to another interface.',
			'A firewall or proxy is actively rejecting the connection.',
		],
		commands: ['ss -ltnp', 'iptables -L -n', 'systemctl status <service-name>'],
	},
	{
		id: 'too-many-open-files',
		matchers: ['too many open files', 'emfile'],
		category: 'File descriptor exhaustion',
		title: 'Too many open files',
		meaning:
			'The process hit its file descriptor limit and cannot open more sockets, files, or pipes.',
		causes: [
			'The process leaks file descriptors.',
			'The per-process ulimit is too low.',
			'Connection churn is higher than the current limits can handle.',
		],
		commands: ['ulimit -n', 'lsof -p <pid> | wc -l', 'cat /proc/<pid>/limits'],
	},
	{
		id: 'io-timeout',
		matchers: ['i/o timeout', 'io timeout'],
		category: 'Network or service timeout',
		title: 'I/O timeout',
		meaning:
			'The application waited for network or storage I/O but did not receive a response in time.',
		causes: [
			'Network latency or packet loss is too high.',
			'The target service is slow or overloaded.',
			'Timeout values are shorter than real-world response times.',
		],
		commands: ['ping <host>', 'mtr -rw <host>', 'iostat -xz 1 5'],
	},
	{
		id: 'address-already-in-use',
		matchers: ['address already in use', 'eaddrinuse'],
		category: 'Port binding conflict',
		title: 'Address already in use',
		meaning:
			'Your process tried to bind an IP and port that is already occupied or still waiting in TIME_WAIT related states.',
		causes: [
			'Another process already listens on the same port.',
			'The old process did not exit cleanly.',
			'Rapid restart behavior exposed socket reuse issues.',
		],
		commands: ['ss -ltnp', 'lsof -i :<port>', 'ps -fp <pid>'],
	},
	{
		id: 'no-route-to-host',
		matchers: ['no route to host', 'ehostunreach'],
		category: 'Routing failure',
		title: 'No route to host',
		meaning:
			'The operating system does not know how to reach the target IP through the current routing table or network path.',
		causes: [
			'A route is missing or incorrect.',
			'The target network is down or unreachable.',
			'A firewall or security group is blocking the path.',
		],
		commands: ['ip route', 'traceroute <host>', 'ping <gateway-ip>'],
	},
];

export function findRule(input: string): ErrorRule | undefined {
	const normalized = input.toLowerCase();
	return errorRules.find((rule) => rule.matchers.some((matcher) => normalized.includes(matcher)));
}
