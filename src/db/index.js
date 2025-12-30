import mongoose from "mongoose";
import { DB_NAME } from "../constants.js";

const connectDb = async () => {
  try {
    const connectionInstance = await mongoose.connect(
      `${process.env.MONGO_URL}/${DB_NAME}`,
    );
    console.log("******** NO ERROR CATCHED*******");
    console.log(
      "MONGODB connected !!(^ - ^)",
      connectionInstance.connection.host,
    );
    console.log(`connectionInstance: ${connectionInstance}`);
    console.log("DB NAME", connectionInstance.connection.name);
    console.log("DB PORT", connectionInstance.connection.port);
  } catch (error) {
    console.log("********ERROR CATCHED*******");
    console.log("MONGODB connection failed ERROR", error);
    process.exit(1);
  }
};

export default connectDb;
