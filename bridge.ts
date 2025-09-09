import { defineChain, createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicActionsL1, publicActionsL2, walletActionsL1, walletActionsL2, getL2TransactionHashes } from "viem/op-stack";
import { sepolia } from "viem/chains";
import { formatEther, parseEther } from "viem";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ========================
// Logger Configuration
// ========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BridgeLogger {
    constructor(logLevel = 'INFO') {
        this.logLevel = logLevel;
        this.logLevels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
        this.logDir = path.join(__dirname, 'logs');
        this.sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);

        // Ensure log directory exists
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        this.logFile = path.join(this.logDir, `bridge_${new Date().toISOString().split('T')[0]}.log`);
        this.errorFile = path.join(this.logDir, `bridge_errors_${new Date().toISOString().split('T')[0]}.log`);
        this.debugFile = path.join(this.logDir, `bridge_debug_${new Date().toISOString().split('T')[0]}.log`);

        [this.logFile, this.errorFile, this.debugFile].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });

        // Initialize session
        this.info('='.repeat(80));
        this.info(`BRIDGE SESSION STARTED - ID: ${this.sessionId}`);
        this.info(`Timestamp: ${new Date().toISOString()}`);
        this.info('='.repeat(80));
    }

    shouldLog(level) {
        return this.logLevels[level] <= this.logLevels[this.logLevel];
    }

    formatMessage(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const sessionInfo = `[${this.sessionId}]`;
        let formatted = `[${timestamp}] ${sessionInfo} [${level}] ${message}`;

        if (data) {
            // Handle BigInt serialization
            const serializableData = this.convertBigIntToString(data);
            formatted += `\nData: ${JSON.stringify(serializableData, null, 2)}`;
        }

        return formatted;
    }

    // Helper method to convert BigInt to string for serialization
    convertBigIntToString(obj: any): any {
        if (typeof obj === 'bigint') {
            return obj.toString();
        }

        if (obj === null || obj === undefined) {
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.convertBigIntToString(item));
        }

        if (typeof obj === 'object') {
            const result: any = {};
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    result[key] = this.convertBigIntToString(obj[key]);
                }
            }
            return result;
        }

        return obj;
    }

    writeToFile(filename, content) {
        try {
            fs.appendFileSync(filename, content + '\n');
        } catch (error) {
            console.error(`Failed to write to log file ${filename}:`, error);
        }
    }

    log(level, message, data = null) {
        if (!this.shouldLog(level)) return;

        const formatted = this.formatMessage(level, message, data);
        console.log(formatted);

        // Write to main log file
        this.writeToFile(this.logFile, formatted);

        // Write to specific files based on level
        if (level === 'ERROR') {
            this.writeToFile(this.errorFile, formatted);
        }

        if (level === 'DEBUG' || level === 'TRACE') {
            this.writeToFile(this.debugFile, formatted);
        }
    }

    error(message, data = null) { this.log('ERROR', message, data); }
    warn(message, data = null) { this.log('WARN', message, data); }
    info(message, data = null) { this.log('INFO', message, data); }
    debug(message, data = null) { this.log('DEBUG', message, data); }
    trace(message, data = null) { this.log('TRACE', message, data); }

    logTransaction(phase, txHash, txData = null) {
        this.info(`TRANSACTION ${phase}`, {
            hash: txHash,
            timestamp: new Date().toISOString(),
            ...txData
        });
    }

    logBalance(location, address, balance, currency = 'ETH') {
        this.info(`BALANCE CHECK - ${location}`, {
            address,
            balance: formatEther(balance),
            currency,
            wei: balance.toString()
        });
    }

    logGasEstimate(operation, gasEstimate, gasPrice = null) {
        const data = {
            operation,
            gasEstimate: gasEstimate.toString(),
            estimatedCost: gasPrice ? formatEther(gasEstimate * gasPrice) + ' ETH' : 'N/A'
        };

        if (gasPrice) {
            data.gasPrice = gasPrice.toString();
        }

        this.debug('GAS ESTIMATION', data);
    }

    logNetworkInfo(network, chainId, blockNumber) {
        this.debug(`NETWORK INFO - ${network}`, {
            chainId,
            blockNumber,
            timestamp: new Date().toISOString()
        });
    }

    logDepositArgs(args) {
        this.debug('DEPOSIT ARGUMENTS', {
            mint: args.mint ? formatEther(args.mint) : 'N/A',
            to: args.to,
            gas: args.gas?.toString(),
            isCreation: args.isCreation,
            data: args.data
        });
    }

    logError(operation, error) {
        this.error(`OPERATION FAILED: ${operation}`, {
            message: error.message,
            stack: error.stack,
            code: error.code,
            timestamp: new Date().toISOString()
        });
    }

    endSession(success = true) {
        this.info('='.repeat(80));
        this.info(`BRIDGE SESSION ENDED - ${success ? 'SUCCESS' : 'FAILURE'}`);
        this.info(`Session ID: ${this.sessionId}`);
        this.info(`Duration: ${Date.now() - parseInt(this.sessionId, 36)} ms`);
        this.info('='.repeat(80));
    }
}

// ========================
// Load env variables with validation
// ========================
const logger = new BridgeLogger(process.env.LOG_LEVEL || 'DEBUG');

const requiredEnvVars = [
    'TEST_PRIVATE_KEY',
    'L1_RPC_URL',
    'L2_RPC_URL',
    'L2_CHAIN_ID'
];

const optionalEnvVars = [
    'PORTAL_ADDRESS',
    'L1_STANDARD_BRIDGE_ADDRESS',
    'DISPUTE_GAME_FACTORY_ADDRESS',
    'MULTICALL3_ADDRESS',
    'DEPOSIT_AMOUNT'
];

logger.info('ENVIRONMENT VALIDATION STARTING');

const envConfig = {};
let missingRequired = [];

// Check required variables
requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
        missingRequired.push(varName);
    } else {
        envConfig[varName] = process.env[varName];
        logger.debug(`ENV VAR LOADED: ${varName} = ${varName === 'TEST_PRIVATE_KEY' ? '[REDACTED]' : process.env[varName]}`);
    }
});

// Check optional variables
optionalEnvVars.forEach(varName => {
    envConfig[varName] = process.env[varName] || '';
    if (process.env[varName]) {
        logger.debug(`OPTIONAL ENV VAR LOADED: ${varName} = ${process.env[varName]}`);
    } else {
        logger.warn(`OPTIONAL ENV VAR MISSING: ${varName}`);
    }
});

if (missingRequired.length > 0) {
    logger.error('MISSING REQUIRED ENVIRONMENT VARIABLES', { missing: missingRequired });
    throw new Error(`Missing required environment variables: ${missingRequired.join(', ')}`);
}

logger.info('ENVIRONMENT VALIDATION COMPLETED');

// ========================
// Define chains with enhanced logging
// ========================
logger.info('CHAIN CONFIGURATION STARTING');

const giwaSepolia = defineChain({
    id: Number(envConfig.L2_CHAIN_ID),
    name: 'Giwa Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
        default: { http: [envConfig.L2_RPC_URL] },
    },
    contracts: {
        multicall3: { address: envConfig.MULTICALL3_ADDRESS || '0x' },
        l2OutputOracle: {},
        disputeGameFactory: { [sepolia.id]: { address: envConfig.DISPUTE_GAME_FACTORY_ADDRESS || '0x' } },
        portal: { [sepolia.id]: { address: envConfig.PORTAL_ADDRESS || '0x' } },
        l1StandardBridge: { [sepolia.id]: { address: envConfig.L1_STANDARD_BRIDGE_ADDRESS || '0x' } },
    },
    testnet: true,
});

logger.debug('L2 CHAIN DEFINED', {
    id: giwaSepolia.id,
    name: giwaSepolia.name,
    rpcUrl: envConfig.L2_RPC_URL,
    contracts: giwaSepolia.contracts
});

logger.info('CHAIN CONFIGURATION COMPLETED');

// ========================
// Wallet setup with enhanced security logging
// ========================
logger.info('WALLET INITIALIZATION STARTING');

let account;
try {
    account = privateKeyToAccount(envConfig.TEST_PRIVATE_KEY);
    logger.info('WALLET CREATED', {
        address: account.address,
        type: account.type
    });
} catch (error) {
    logger.logError('WALLET_CREATION', error);
    throw error;
}

logger.info('WALLET INITIALIZATION COMPLETED');

// ========================
// Enhanced Client Setup
// ========================
logger.info('CLIENT INITIALIZATION STARTING');

const publicClientL1 = createPublicClient({
    chain: sepolia,
    transport: http(envConfig.L1_RPC_URL)
}).extend(publicActionsL1());

const walletClientL1 = createWalletClient({
    account,
    chain: sepolia,
    transport: http(envConfig.L1_RPC_URL)
}).extend(walletActionsL1());

const publicClientL2 = createPublicClient({
    chain: giwaSepolia,
    transport: http(envConfig.L2_RPC_URL)
}).extend(publicActionsL2());

const walletClientL2 = createWalletClient({
    account,
    chain: giwaSepolia,
    transport: http(envConfig.L2_RPC_URL)
}).extend(walletActionsL2());

logger.info('CLIENT INITIALIZATION COMPLETED');

// ========================
// Network Health Check
// ========================
async function performNetworkHealthCheck() {
    logger.info('NETWORK HEALTH CHECK STARTING');

    try {
        // Check L1 connectivity
        const l1BlockNumber = await publicClientL1.getBlockNumber();
        logger.logNetworkInfo('L1 (Sepolia)', sepolia.id, l1BlockNumber);

        // Check L2 connectivity  
        const l2BlockNumber = await publicClientL2.getBlockNumber();
        logger.logNetworkInfo('L2 (Giwa)', giwaSepolia.id, l2BlockNumber);

        // Check account balances
        const l1Balance = await publicClientL1.getBalance({ address: account.address });
        logger.logBalance('L1', account.address, l1Balance);

        const l2Balance = await publicClientL2.getBalance({ address: account.address });
        logger.logBalance('L2', account.address, l2Balance);

        // Validate minimum balance for deposit
        const depositAmount = parseEther(envConfig.DEPOSIT_AMOUNT || "0.001");
        if (l1Balance < depositAmount) {
            logger.warn('INSUFFICIENT L1 BALANCE', {
                required: formatEther(depositAmount),
                available: formatEther(l1Balance),
                deficit: formatEther(depositAmount - l1Balance)
            });
        }

        logger.info('NETWORK HEALTH CHECK COMPLETED');
        return { l1Balance, l2Balance, l1BlockNumber, l2BlockNumber };

    } catch (error) {
        logger.logError('NETWORK_HEALTH_CHECK', error);
        throw error;
    }
}

// ========================
// Enhanced Deposit Function
// ========================
async function executeDeposit(depositAmount) {
    logger.info('DEPOSIT OPERATION STARTING', {
        amount: formatEther(depositAmount),
        from: account.address
    });

    try {
        // Build deposit transaction with detailed logging
        logger.debug('BUILDING DEPOSIT TRANSACTION');
        const depositArgs = await publicClientL2.buildDepositTransaction({
            mint: depositAmount,
            to: account.address,
        });

        logger.logDepositArgs(depositArgs);

        // Gas estimation for L1 transaction
        if (depositArgs.gas) {
            try {
                const gasPrice = await publicClientL1.getGasPrice();
                logger.logGasEstimate('DEPOSIT_L1', depositArgs.gas, gasPrice);
            } catch (gasError) {
                logger.warn('GAS ESTIMATION FAILED', { error: gasError.message });
            }
        }

        // Execute deposit transaction on L1
        logger.info('SUBMITTING L1 DEPOSIT TRANSACTION');
        const depositHash = await walletClientL1.depositTransaction(depositArgs);
        logger.logTransaction('SUBMITTED_L1', depositHash, {
            network: 'Sepolia',
            amount: formatEther(depositAmount),
            to: account.address
        });

        // Wait for L1 confirmation with progress logging
        logger.info('WAITING FOR L1 CONFIRMATION', { hash: depositHash });
        const depositReceipt = await publicClientL1.waitForTransactionReceipt({
            hash: depositHash,
            onReplaced: (replacement) => {
                logger.warn('L1 TRANSACTION REPLACED', {
                    original: depositHash,
                    replacement: replacement.transactionHash,
                    reason: replacement.reason
                });
            }
        });

        logger.logTransaction('CONFIRMED_L1', depositHash, {
            blockNumber: depositReceipt.blockNumber,
            gasUsed: depositReceipt.gasUsed.toString(),
            effectiveGasPrice: depositReceipt.effectiveGasPrice?.toString(),
            status: depositReceipt.status
        });

        // Extract and track L2 transaction
        const l2Hashes = getL2TransactionHashes(depositReceipt);
        if (l2Hashes.length === 0) {
            throw new Error('No L2 transaction hash found in deposit receipt');
        }

        const l2Hash = l2Hashes[0];
        logger.logTransaction('DETECTED_L2', l2Hash, {
            derivedFrom: depositHash,
            network: 'Giwa'
        });

        // Wait for L2 confirmation with timeout
        logger.info('WAITING FOR L2 CONFIRMATION', { hash: l2Hash });
        const l2Receipt = await publicClientL2.waitForTransactionReceipt({
            hash: l2Hash,
            timeout: 300000, // 5 minutes
            onReplaced: (replacement) => {
                logger.warn('L2 TRANSACTION REPLACED', {
                    original: l2Hash,
                    replacement: replacement.transactionHash,
                    reason: replacement.reason
                });
            }
        });

        logger.logTransaction('CONFIRMED_L2', l2Hash, {
            blockNumber: l2Receipt.blockNumber.toString(),
            gasUsed: l2Receipt.gasUsed.toString(),
            effectiveGasPrice: l2Receipt.effectiveGasPrice?.toString() || 'N/A',
            status: l2Receipt.status
        });

        // Verify balance changes
        const newL1Balance = await publicClientL1.getBalance({ address: account.address });
        const newL2Balance = await publicClientL2.getBalance({ address: account.address });

        logger.logBalance('L1_POST_DEPOSIT', account.address, newL1Balance);
        logger.logBalance('L2_POST_DEPOSIT', account.address, newL2Balance);

        logger.info('DEPOSIT OPERATION COMPLETED SUCCESSFULLY', {
            l1Hash: depositHash,
            l2Hash: l2Hash,
            amount: formatEther(depositAmount)
        });

        return {
            l1Hash: depositHash,
            l2Hash: l2Hash,
            l1Receipt: depositReceipt,
            l2Receipt: l2Receipt
        };

    } catch (error) {
        logger.logError('DEPOSIT_OPERATION', error);
        throw error;
    }
}

// ========================
// Main Execution Function
// ========================
async function main() {
    let success = false;

    try {
        logger.info('BRIDGE SCRIPT EXECUTION STARTING');

        // Perform health checks
        await performNetworkHealthCheck();

        // Execute deposit
        const depositAmount = parseEther(envConfig.DEPOSIT_AMOUNT || "0.001");
        const result = await executeDeposit(depositAmount);

        logger.info('BRIDGE OPERATION COMPLETED SUCCESSFULLY', {
            l1TransactionHash: result.l1Hash,
            l2TransactionHash: result.l2Hash,
            depositAmount: formatEther(depositAmount)
        });

        success = true;

    } catch (error) {
        logger.logError('MAIN_EXECUTION', error);
        success = false;
        throw error;

    } finally {
        logger.endSession(success);

        // Log file locations
        console.log('\n' + '='.repeat(60));
        console.log('LOG FILES GENERATED:');
        console.log(`Main Log: ${logger.logFile}`);
        console.log(`Error Log: ${logger.errorFile}`);
        console.log(`Debug Log: ${logger.debugFile}`);
        console.log('='.repeat(60));
    }
}

// ========================
// Error Handling & Execution
// ========================
process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT EXCEPTION', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
    });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED PROMISE REJECTION', {
        reason: reason?.toString(),
        promise: promise?.toString(),
        timestamp: new Date().toISOString()
    });
    process.exit(1);
});

// Execute main function
main().catch((error) => {
    logger.logError('SCRIPT_EXECUTION', error);
    process.exit(1);
});